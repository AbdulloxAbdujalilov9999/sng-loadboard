import pg from 'pg';

const CHANNEL = 'sng_events';
const MAX_CONNS_PER_USER = 5;
const MAX_BUFFERED_BYTES = 1_000_000;

/** Publish inside the caller's transaction: subscribers are notified only if/when it commits. */
export async function publish(db, evt) {
  await db.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(evt)]);
}

/**
 * Server-Sent-Events hub. Every API instance LISTENs on one Postgres channel and fans events out to
 * its own browser connections, so it scales horizontally with no extra infrastructure (no Redis).
 * Events carry only entity/op/id - never row data - so clients re-fetch through the normal,
 * authorised API.
 */
export class EventHub {
  constructor({ config, log }) {
    this.config = config;
    this.log = log;
    this.conns = new Set();
    this.perUser = new Map();   // email -> open streams (O(1) limit check even with thousands of connections)
    this.pending = new Map();   // entity -> batch waiting for the next flush
    this.flushTimer = null;
    this.listener = null;
    this.retryMs = 500;
    this.closed = false;
    this.heartbeat = null;
    this.observers = new Set();
  }

  /** Observe every event (and 'resync' after a listener reconnect) - used to invalidate caches. */
  observe(fn) { this.observers.add(fn); return () => this.observers.delete(fn); }

  #notifyObservers(evt) {
    for (const fn of this.observers) { try { fn(evt); } catch (e) { this.log.warn({ e: e.message }, 'observer failed'); } }
  }

  async start() {
    this.heartbeat = setInterval(() => this.#write(': ping\n\n'), 20_000);
    this.heartbeat.unref();
    await this.#connect();
  }

  async #connect() {
    if (this.closed) return;
    const client = new pg.Client({
      connectionString: this.config.databaseUrl,
      ssl: this.config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      keepAlive: true,
      application_name: 'sng-one-events',
    });
    const reconnect = (why) => {
      if (this.closed || this.listener !== client) return;
      this.listener = null;
      this.log.warn({ why }, 'event listener lost; reconnecting');
      client.removeAllListeners();
      client.end().catch(() => {});
      // Tell every browser to re-fetch: events may have been missed while we were disconnected.
      this.#notifyObservers({ entity: 'resync' });
      this.#broadcast({ entity: 'resync' }, () => true);
      setTimeout(() => this.#connect().catch(() => {}), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    };
    client.on('error', (e) => reconnect(e.message));
    client.on('end', () => reconnect('connection ended'));
    client.on('notification', (msg) => {
      try { this.dispatch(JSON.parse(msg.payload)); } catch (e) { this.log.warn({ e: e.message }, 'bad event payload'); }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
      this.retryMs = 500;
    } catch (err) {
      client.removeAllListeners();
      client.end().catch(() => {});
      if (this.closed) return;
      this.log.warn({ err: err.message }, 'event listener connect failed; retrying');
      setTimeout(() => this.#connect().catch(() => {}), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    }
  }

  /** Route one DB event to the right browsers. Audience rules live here, in one place. */
  dispatch(evt) {
    this.#notifyObservers(evt);
    switch (evt.entity) {
      case 'loads':
      case 'trucks':
        return this.#enqueue(evt);
      case 'fx':
        return this.#broadcast(evt, (c) => c.approved);
      case 'members':
        return this.#broadcast(evt, (c) => c.isOwner);
      case 'me': // a membership decision about one specific person
        return this.#broadcast({ entity: 'me' }, (c) => c.email === evt.email);
      default:
        return undefined;
    }
  }

  /** Register a browser connection. Returns false when the user has too many open streams. */
  add(conn) {
    const mine = this.perUser.get(conn.email) ?? 0;
    if (mine >= MAX_CONNS_PER_USER) return false;
    this.perUser.set(conn.email, mine + 1);
    this.conns.add(conn);
    return true;
  }

  remove(conn) { this.#drop(conn); }

  #drop(conn) {
    if (!this.conns.delete(conn)) return;
    const left = (this.perUser.get(conn.email) ?? 1) - 1;
    if (left > 0) this.perUser.set(conn.email, left); else this.perUser.delete(conn.email);
  }

  /**
   * Board changes are coalesced: at most ONE frame per entity per window, however many rows changed.
   * Without this, N posts/second x M open browsers = N*M socket writes/second, and (worse) every
   * browser would re-query the board for each of them. The frame says how many inserts it covers
   * (and by whom, so a browser can discount its own posts).
   */
  #enqueue(evt) {
    const batchMs = this.config.eventBatchMs ?? 1000;
    if (batchMs <= 0) return this.#broadcast(evt, (c) => c.approved);
    let b = this.pending.get(evt.entity);
    if (!b) { b = { n: 0, inserts: 0, ops: new Set(), owners: new Map(), last: evt }; this.pending.set(evt.entity, b); }
    b.n += 1; b.last = evt; b.ops.add(evt.op);
    if (evt.op === 'insert') {
      b.inserts += 1;
      if (evt.ownerId != null) b.owners.set(evt.ownerId, (b.owners.get(evt.ownerId) ?? 0) + 1);
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.#flush(), batchMs);
      this.flushTimer.unref();
    }
  }

  #flush() {
    this.flushTimer = null;
    const batches = [...this.pending.entries()];
    this.pending.clear();
    for (const [entity, b] of batches) {
      const evt = b.n === 1
        ? { ...b.last, n: 1 }
        : { entity, op: b.ops.size === 1 ? [...b.ops][0] : 'mixed', n: b.n, inserts: b.inserts };
      if (b.n > 1 && b.owners.size <= 50) evt.owners = Object.fromEntries(b.owners);
      this.#broadcast(evt, (c) => c.approved);
    }
  }

  #broadcast(evt, wants) {
    const frame = `event: change\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const c of this.conns) if (wants(c)) this.#send(c, frame);
  }

  #write(frame) {
    for (const c of this.conns) this.#send(c, frame);
  }

  #send(conn, frame) {
    const raw = conn.raw;
    if (raw.destroyed || raw.writableEnded) { this.#drop(conn); return; }
    if (raw.writableLength > MAX_BUFFERED_BYTES) { // client not reading: drop it, it will reconnect + refetch
      this.#drop(conn);
      raw.destroy();
      return;
    }
    raw.write(frame);
  }

  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.flushTimer);
    for (const c of this.conns) { try { c.raw.end(); } catch { /* ignore */ } }
    this.conns.clear();
    this.perUser.clear();
    if (this.listener) {
      const l = this.listener;
      this.listener = null;
      l.removeAllListeners();
      await l.end().catch(() => {});
    }
  }
}
