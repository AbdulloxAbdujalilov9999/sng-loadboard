// The "any load, the moment it's posted, goes to every group" half of the bot. Opens its OWN
// Postgres LISTEN connection on the same channel the API's EventHub uses (server/src/events.js),
// but does NOT go through EventHub: that hub coalesces bursts into one "something changed, refetch"
// frame per second for browsers, which would lose individual loads. The bot instead reacts to every
// single insert notification, fetches that one row, and posts it - whether it was created from the
// web app or from /postload here, since both go through the same `loads` table and the same
// `publish()` call in server/src/events.js.
import pg from 'pg';
import { formatLoadMessage, formatTruckMessage, truckRowToDto, escapeHtml, joinLines } from './format.js';
import { loadKeyboard } from './editor.js';
import { t } from './i18n.js';

const CHANNEL = 'sng_events';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeBroadcaster({ config, pool, store, bot, log = console, sleep = defaultSleep, suppressOwner = () => false }) {
  let listener = null; // the currently-live LISTEN client, or null while reconnecting
  let closed = false;
  let retryMs = 500;
  let catchUpTimer = null;
  let queue = Promise.resolve(); // serialises sends so a slow broadcast can't overlap the next one

  async function fetchLoad(id) {
    const { rows: [row] } = await pool.query('SELECT * FROM loads WHERE id = $1', [id]);
    return row ?? null;
  }

  // Telegram caps a bot at ~20 messages a minute per group. Past that it answers 429 with how long to wait;
  // we wait exactly that long and try again (a member posting 40 loads in one go must not lose broadcasts).
  // Telegram lets a group take about 20 messages a minute and a private chat about one a second. A member posting 50 loads at once
  // must not lose any broadcast, so sends to the same chat are spaced out up front (and a 429 is still waited out below).
  const lastSentAt = new Map();
  async function pace(chatId, gapMs) {
    if (!(gapMs > 0)) return;
    const wait = (lastSentAt.get(chatId) ?? 0) + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastSentAt.set(chatId, Date.now());
  }

  async function sendWithRetry(chatId, text, extra = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
      } catch (err) {
        if (err?.response?.error_code !== 429 || attempt >= 8) throw err;
        const waitS = Number(err.response.parameters?.retry_after ?? 5);
        await sleep(Math.min(waitS, 60) * 1000 + 250);
      }
    }
  }

  // Shared error handling for a send to any chat (group or DM): Telegram throttling is already
  // retried inside sendWithRetry; this only deals with the chat having gone away entirely.
  async function handleSendError(err, chatId) {
    const code = err?.response?.error_code;
    const gone = /chat not found|kicked|not a member|deactivated/i.test(err?.response?.description ?? err.message ?? '');
    // 403 = bot was removed/blocked without us hearing a my_chat_member update; stop posting there.
    if (code === 403 || (code === 400 && gone)) await store.markChatRemoved(chatId, config.botId).catch(() => {});
    else log.warn?.(`broadcast to ${chatId} failed: ${err.message}`) ?? console.warn(`broadcast to ${chatId} failed: ${err.message}`);
  }

  // ---- one worker per chat -------------------------------------------------------------------------------------------------
  // Every chat has its own to-do list and its own worker, so a slow or flooded group never holds up the others or the poster's DM.
  // EVERY load is its own message, in every chat. A group takes about 20 messages a minute, so 50 loads need about 2.5 minutes to land
  // there; they are paced to that and none is dropped. (Merging a burst into a few big messages is possible - BOT_BROADCAST_DIGEST=1 - but
  // it is OFF: members want one message per load.)
  const DIGEST_MIN_QUEUED = config.broadcastDigest ? 3 : Infinity;
  const DIGEST_MAX_LOADS = 5;
  const DIGEST_MAX_CHARS = 3600; // Telegram's limit is 4096
  const DIGEST_SEPARATOR = '\n\n━━━━━━━━━━\n\n';
  const chatQueues = new Map(); // chatId -> { items: [], busy }
  const inFlight = new Set();   // `${loadId}:${chatId}` - queued or being sent right now

  const groupSuffix = () => { const join = joinLines(config, config.broadcastLang); return join ? `\n\n${join}` : ''; };

  function takeBatch(q) {
    const first = q.items[0];
    if (first.own || q.items.length < DIGEST_MIN_QUEUED) return [q.items.shift()];
    const batch = [];
    let chars = 0;
    while (q.items.length && !q.items[0].own && batch.length < DIGEST_MAX_LOADS && (!batch.length || chars + q.items[0].text.length + DIGEST_SEPARATOR.length <= DIGEST_MAX_CHARS)) {
      const item = q.items.shift();
      chars += item.text.length + DIGEST_SEPARATOR.length;
      batch.push(item);
    }
    return batch;
  }

  async function deliver(chatId, batch) {
    if (batch[0].own) {
      // The poster's own chat: tracked, so closing the load later pulls its message back out (see handleDelete).
      const [item] = batch;
      if (suppressOwner(item.loadId)) return; // cleared from the chat while it was still on its way
      const lang = (await store.getLanguage?.(chatId)) ?? config.broadcastLang;
      await pace(chatId, config.broadcastOwnerGapMs);
      const sent = await sendWithRetry(chatId, item.text + groupSuffix(), loadKeyboard(lang, item.loadId));
      if (sent?.message_id != null) {
        await store.saveSentMessage({ loadId: item.loadId, chatId, messageId: sent.message_id })
          .catch((err) => log.warn?.(`tracking message for load ${item.loadId} in ${chatId} failed: ${err.message}`));
      }
      return;
    }
    // A group or channel: fire-and-forget on purpose - NOT remembered in telegram_load_messages, so closing a load never reaches into
    // a group to delete anything (members may be relying on it). Only "this load reached this chat" is recorded, to catch up later.
    await pace(chatId, config.broadcastGroupGapMs);
    await sendWithRetry(chatId, batch.map((i) => i.text).join(DIGEST_SEPARATOR) + groupSuffix());
    const loadIds = batch.map((i) => i.loadId).filter((id) => typeof id === 'number'); // trucks are fire-and-forget: nothing to catch up on
    if (loadIds.length) await store.markBroadcasts?.(chatId, loadIds).catch((err) => log.warn?.(`recording broadcast failed: ${err.message}`));
  }

  async function runChat(chatId, q) {
    q.busy = true;
    try {
      while (q.items.length) {
        const batch = takeBatch(q);
        try { await deliver(chatId, batch); } catch (err) { await handleSendError(err, chatId); } finally {
          for (const item of batch) { inFlight.delete(`${item.loadId}:${chatId}`); item.done(); }
        }
      }
    } finally { q.busy = false; }
  }

  /** Queues a load for a chat; resolves when it has been sent (or given up on). */
  function enqueue(chatId, item) {
    const key = `${item.loadId}:${chatId}`;
    if (inFlight.has(key)) return Promise.resolve();
    inFlight.add(key);
    let q = chatQueues.get(chatId);
    if (!q) { q = { items: [], busy: false }; chatQueues.set(chatId, q); }
    const done = new Promise((resolve) => { item.done = resolve; });
    q.items.push(item);
    if (!q.busy) runChat(chatId, q);
    return done;
  }

  function linkFor(row) {
    // Each load gets its own link back to this exact load on the web board (GET /api/loads/:id backs it, see server/src/routes/loads.js).
    return config.webUrlIsPublic === false ? null : `${config.webBaseUrl}/?load=${row.id}`; // never broadcast a dead (internal) address
  }

  /** Sends one load to the given groups (and, if `owner`, to the poster's own chat). */
  async function broadcastLoad(row, chatIds, { owner = false } = {}) {
    const text = formatLoadMessage(row, config.broadcastLang, linkFor(row));
    const waits = chatIds.map((chatId) => enqueue(chatId, { loadId: row.id, text }));
    if (owner) {
      const ownerChat = await store.getTelegramUserIdByMemberId(row.owner_id);
      if (ownerChat) waits.push(enqueue(ownerChat, { loadId: row.id, text, own: true }));
    }
    await Promise.all(waits);
  }

  async function fetchTruck(id) {
    const { rows: [row] } = await pool.query('SELECT * FROM trucks WHERE id = $1', [id]);
    return row ?? null;
  }

  /** A truck posted from the website or the bot goes to the same groups, as its own message, paced like loads. */
  async function broadcastTruck(row, chatIds) {
    const text = formatTruckMessage(truckRowToDto(row), config.broadcastLang);
    await Promise.all(chatIds.map((chatId) => enqueue(chatId, { loadId: `T${row.id}`, text })));
  }

  // A load that was closed before its turn came never needs to be sent.
  function forget(loadId) {
    for (const [chatId, q] of chatQueues) {
      q.items = q.items.filter((item) => {
        if (item.loadId !== loadId) return true;
        inFlight.delete(`${loadId}:${chatId}`);
        item.done();
        return false;
      });
    }
  }

  // After a restart or a failed send: send what some group never got (migration 019). Runs once at start and then every minute.
  async function catchUp() {
    if (closed || typeof store.listUnsentBroadcasts !== 'function') return;
    const rows = await store.listUnsentBroadcasts(config.botId);
    const byLoad = new Map();
    for (const { load_id: id, chat_id: chatId } of rows) {
      if (inFlight.has(`${id}:${chatId}`)) continue;
      byLoad.set(id, [...(byLoad.get(id) ?? []), chatId]);
    }
    for (const [id, chatIds] of byLoad) {
      const row = await fetchLoad(id);
      if (row?.status === 'active') broadcastLoad(row, chatIds).catch((err) => log.warn?.(`catch-up for load ${id} failed: ${err.message}`));
    }
    if (byLoad.size) log.info?.(`catch-up: ${byLoad.size} load(s) had not reached every group yet`);
  }

  // The load was closed/removed (DELETE /api/loads/:id, from the web app, /postload... or /myloads
  // below): pull it back out of the poster's own chat (see deliver() - groups/channels are never
  // tracked here, so this never touches them). Telegram refuses to delete a message once it's more
  // than 48h old (or already gone) - nothing more to do there, but the row is forgotten regardless
  // so this never retries forever.
  async function handleDelete(loadId) {
    const sent = await store.listSentMessages(loadId);
    for (const { chat_id: chatId, message_id: messageId } of sent) {
      await bot.telegram.deleteMessage(chatId, messageId)
        .catch((err) => log.warn?.(`could not delete message ${messageId} in ${chatId} for load ${loadId}: ${err.message}`));
    }
    await store.deleteSentMessages(loadId);
  }

  // A new member signed up: tell the platform owner(s) on Telegram (the web app tells them too, while it is open).
  async function notifyOwners(memberId) {
    const { rows: [m] } = await pool.query('SELECT * FROM members WHERE id = $1', [memberId]);
    if (!m || m.role === 'owner') return;
    const owners = await store.listOwnerTelegramIds?.() ?? [];
    if (!owners.length) return;
    const login = /^p\d+@phone\.sng$/.test(m.email) ? `+${m.email.slice(1, -'@phone.sng'.length)}` : m.email;
    const name = m.company && m.company !== m.contact_name ? `${m.company} (${m.contact_name})` : (m.contact_name || m.company);
    const contact = [...new Set([m.phone, m.telegram, m.contact_email, login].filter(Boolean))].join(' · ');
    for (const id of owners) {
      const lang = (await store.getLanguage?.(id)) ?? config.broadcastLang;
      await bot.telegram.sendMessage(id, t(lang, 'owner_new_member', { name: escapeHtml(name), contact: escapeHtml(contact) }), { parse_mode: 'HTML' })
        .catch((err) => log.warn?.(`owner notice to ${id} failed: ${err.message}`));
    }
  }

  // Each branch below catches its OWN errors inside the function handed to queue.then(), so the
  // promise that .then() returns - and therefore `queue` itself - never rejects. A rejected `queue`
  // would otherwise poison every later call forever: queue.then(fn) on an already-rejected promise
  // skips fn and just re-rejects, so one bad event would silently stop all future broadcasts until
  // the process restarts.
  async function handleEvent(evt) {
    if (evt?.entity === 'members' && evt.op === 'insert' && evt.id) {
      queue = queue.then(() => notifyOwners(evt.id)
        .catch((err) => log.error?.(`owner notice failed: ${err.message}`) ?? console.error(`owner notice failed: ${err.message}`)));
      await queue;
      return;
    }
    if (evt?.entity === 'trucks' && evt.op === 'insert' && evt.id && config.broadcastTrucks !== false) {
      const row = await fetchTruck(evt.id);
      if (!row || row.status !== 'active') return;
      try { await broadcastTruck(row, await store.listActiveChatIds(config.botId)); } catch (err) {
        log.error?.(`truck broadcast failed: ${err.message}`) ?? console.error(`truck broadcast failed: ${err.message}`);
      }
      return;
    }
    if (evt?.entity !== 'loads' || !evt.id) return;
    if (evt.op === 'delete') {
      forget(evt.id);
      queue = queue.then(() => handleDelete(evt.id)
        .catch((err) => log.error?.(`un-broadcasting load ${evt.id} failed: ${err.message}`) ?? console.error(`un-broadcasting load ${evt.id} failed: ${err.message}`)));
      await queue;
      return;
    }
    if (evt.op !== 'insert') return;
    const row = await fetchLoad(evt.id);
    if (!row || row.status !== 'active') return; // closed/edited away again before we got to it
    try {
      await broadcastLoad(row, await store.listActiveChatIds(config.botId), { owner: true });
    } catch (err) {
      log.error?.(`broadcast failed: ${err.message}`) ?? console.error(`broadcast failed: ${err.message}`);
    }
  }

  async function connect() {
    if (closed) return;
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
      application_name: 'sng-one-telegram-bot-listener',
    });
    const reconnect = (why) => {
      if (closed || listener !== client) return; // already superseded by a newer connection attempt
      listener = null;
      log.warn?.(`event listener lost (${why}); reconnecting`) ?? console.warn(`event listener lost (${why}); reconnecting`);
      client.removeAllListeners();
      client.end().catch(() => {});
      setTimeout(() => connect().catch((e) => reconnect(e.message)), retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    };
    client.on('error', (e) => reconnect(e.message));
    client.on('end', () => reconnect('connection ended'));
    client.on('notification', (msg) => {
      try { handleEvent(JSON.parse(msg.payload)); } catch (e) { log.warn?.(`bad event payload: ${e.message}`) ?? console.warn(`bad event payload: ${e.message}`); }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      listener = client;
      retryMs = 500;
    } catch (err) {
      client.removeAllListeners();
      client.end().catch(() => {});
      if (closed) return;
      setTimeout(() => connect().catch(() => {}), retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    }
  }

  return {
    async start() {
      await connect();
      catchUpTimer = setInterval(() => catchUp().catch((err) => log.warn?.(`catch-up failed: ${err.message}`)), 60_000);
      catchUpTimer.unref?.();
      setTimeout(() => catchUp().catch((err) => log.warn?.(`catch-up failed: ${err.message}`)), 5_000).unref?.();
    },
    async stop() {
      closed = true;
      clearInterval(catchUpTimer);
      if (listener) { listener.removeAllListeners(); await listener.end().catch(() => {}); listener = null; }
    },
    // Exposed so bot/test can drive the "a load was inserted" path without a real LISTEN connection.
    _handleEvent: handleEvent,
    _catchUp: catchUp,
  };
}
