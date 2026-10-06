// Concurrent-USERS soak test (not just requests/second):
//   npm run soak                       # 3,000 simulated browsers for 60 s
//   SOAK_USERS=5000 SOAK_SECONDS=120 npm run soak
//
// Parent process = real API + real PostgreSQL (embedded). Child process = the swarm of simulated browsers.
// Each simulated browser behaves like the real web app: holds one live (SSE) connection, runs a board
// search every few seconds, scrolls to the next page, polls nav stats, reacts to live events with the same
// jitter/throttle the web app uses, and a few percent of them post loads.
import { spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const USERS = Number(process.env.SOAK_USERS || 3000);
const SECONDS = Number(process.env.SOAK_SECONDS || 60);
const LOADS = Number(process.env.SOAK_LOADS || 50_000);
const POSTER_PCT = Number(process.env.SOAK_POSTER_PCT || 3); // % of users who post ~1 load/min

const quantile = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);

// =================================================================== swarm (child)
async function swarm() {
  const { base, users, first, seconds, posterPct, cityIds, tokenPrefix } = JSON.parse(process.env.SOAK_CHILD);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lat = { search: [], more: [], stats: [], post: [], mine: [] };
  const errors = new Map();
  const counts = { requests: 0, sseOpen: 0, sseFailed: 0, frames: 0, reconnects: 0 };
  const delivery = []; // ms between a probe post and the frame announcing it
  const probes = [];   // timestamps of probe posts not yet seen by anyone
  const stopAt = Date.now() + seconds * 1000;
  let stopping = false;

  const err = (key) => errors.set(key, (errors.get(key) ?? 0) + 1);
  async function call(kind, user, method, path, body) {
    const t0 = performance.now();
    counts.requests += 1;
    try {
      const res = await fetch(base + path, {
        method, headers: { authorization: `Bearer ${tokenPrefix}:${user.email}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      lat[kind].push(performance.now() - t0);
      if (!res.ok) err(`${kind} ${res.status}`);
      return res.ok ? json : null;
    } catch (e) { err(`${kind} ${e.cause?.code || e.name}`); return null; }
  }

  function searchPath(user) {
    const q = new URLSearchParams({ limit: '50' });
    if (Math.random() < 0.6) { q.set('origin', String(pick(cityIds))); q.set('originRadius', String(pick([50, 100, 200]))); }
    if (Math.random() < 0.3) q.set('dest', String(pick(cityIds)));
    if (Math.random() < 0.4) q.set('equip', pick(['T', 'R', 'F', 'V', 'AC']));
    if (Math.random() < 0.2) { q.set('sort', pick(['rate', 'distance', 'pickup', 'weight'])); q.set('dir', pick(['asc', 'desc'])); }
    return `/api/loads?${q}`;
  }

  async function sse(user) {
    let lastRefetch = 0;
    let timer = null;
    const refetch = () => {
      if (timer || stopping) return;
      const wait = Math.max(Math.random() * 15000, lastRefetch + 15000 - Date.now()); // same as web/js/util.js liveThrottle
      timer = setTimeout(() => { timer = null; lastRefetch = Date.now(); call('search', user, 'GET', searchPath(user)); }, wait);
    };
    while (!stopping) {
      try {
        const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${tokenPrefix}:${user.email}` } });
        if (!res.ok) { counts.sseFailed += 1; err(`sse ${res.status}`); await sleep(rnd(2000, 5000)); continue; }
        counts.sseOpen += 1;
        const dec = new TextDecoder(); let buf = '';
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!frame.startsWith('event: change')) continue;
            counts.frames += 1;
            if (user.listener && probes.length && user.seenProbe !== probes.length && /"entity":"loads"/.test(frame)) {
              user.seenProbe = probes.length; delivery.push(Date.now() - probes[probes.length - 1]);
            }
            if (/"entity":"loads"/.test(frame)) refetch();
          }
        }
        counts.sseOpen -= 1;
      } catch { counts.sseOpen = Math.max(0, counts.sseOpen - 1); }
      counts.reconnects += 1;
      await sleep(rnd(1000, 3000));
    }
  }

  async function behave(user) {
    await sleep(rnd(0, Math.min(15000, users * 4))); // staggered arrival, like real traffic
    sse(user);
    let path = searchPath(user);
    const first = await call('search', user, 'GET', path);
    let cursor = first?.nextCursor;
    let nextStats = Date.now() + rnd(1000, 30000) + 45000;
    let nextPost = user.poster ? Date.now() + rnd(5000, 60000) : Infinity;
    while (Date.now() < stopAt) {
      await sleep(rnd(4000, 12000)); // think time
      const r = Math.random();
      if (r < 0.25 && cursor) { const j = await call('more', user, 'GET', `${path}&cursor=${encodeURIComponent(cursor)}`); cursor = j?.nextCursor; }
      else if (r < 0.8) { path = searchPath(user); const j = await call('search', user, 'GET', path); cursor = j?.nextCursor; }
      else await call('mine', user, 'GET', '/api/loads/mine');
      if (Date.now() > nextStats) { nextStats = Date.now() + 45000 + rnd(0, 30000); await call('stats', user, 'GET', '/api/stats'); }
      if (Date.now() > nextPost) {
        nextPost = Date.now() + rnd(30000, 90000);
        const [o, d] = [pick(cityIds), pick(cityIds)];
        if (o !== d) await call('post', user, 'POST', '/api/loads', {
          originCityId: o, destCityId: d, equip: 'T', fp: 'Full', weightT: 20, pickupDate: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10),
          rateUsd: 1500, commodity: 'Soak test cargo', contactName: 'Soak', contactPhone: '+998 90 123 45 67', contactEmail: user.email, contactTelegram: '@soakuser',
        });
      }
    }
  }

  const people = Array.from({ length: users }, (_, i) => ({ email: `soak${first + i + 1}@example.com`, poster: Math.random() * 100 < posterPct, listener: i % 50 === 0 }));
  // Probe: every 10 s one poster-independent post, so we can time "post -> frame in someone's browser".
  const prober = people.find((p) => p.poster) ?? people[0];
  (async () => {
    await sleep(20000);
    while (Date.now() < stopAt - 15000) {
      probes.push(Date.now());
      await call('post', prober, 'POST', '/api/loads', {
        originCityId: cityIds[0], destCityId: cityIds[1], equip: 'R', fp: 'Full', weightT: 10, pickupDate: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10),
        rateUsd: 900, commodity: 'Probe', contactName: 'Probe', contactPhone: '+998 90 123 45 67', contactEmail: prober.email, contactTelegram: '@probeuser',
      });
      await sleep(10000);
    }
  })();

  await Promise.all(people.map(behave));
  stopping = true;
  // Large payload through a pipe: wait for the write to flush before exiting, or the parent gets it truncated.
  process.stdout.write(`RESULT ${JSON.stringify({ counts, errors: Object.fromEntries(errors), delivery, latency: lat })}\n`, () => process.exit(0));
}

// =================================================================== server (parent)
// =================================================================== parent helpers
async function runSwarms({ base, cityIds, tokenPrefix }) {
  // Several swarm processes: one Node process cannot drive thousands of sockets AND stay a fair timer
  // (and macOS caps a process at ~10k file descriptors).
  const swarms = Math.max(1, Math.ceil(USERS / 1500));
  return Promise.all(Array.from({ length: swarms }, (_, i) => new Promise((resolve) => {
    const share = Math.floor(USERS / swarms) + (i < USERS % swarms ? 1 : 0);
    const first = Math.floor(USERS / swarms) * i + Math.min(i, USERS % swarms);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--swarm'], {
      env: { ...process.env, SOAK_CHILD: JSON.stringify({ base, users: share, first, seconds: SECONDS, posterPct: POSTER_PCT, cityIds, tokenPrefix }) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let o = '';
    child.stdout.on('data', (d) => { o += d; });
    child.on('exit', () => resolve(JSON.parse(o.split('RESULT ')[1])));
  })));
}

const stat = (a) => { const x = [...a].sort((p, q) => p - q); return { n: x.length, p50: +quantile(x, 0.5).toFixed(1), p95: +quantile(x, 0.95).toFixed(1), p99: +quantile(x, 0.99).toFixed(1), max: +(x.at(-1) ?? 0).toFixed(1) }; };

function report({ parts, serverSide, loads, posted }) {
  const res = { counts: {}, errors: {}, delivery: [], latency: { search: [], more: [], stats: [], post: [], mine: [] } };
  for (const p of parts) {
    for (const [k, v] of Object.entries(p.counts)) res.counts[k] = (res.counts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.errors)) res.errors[k] = (res.errors[k] ?? 0) + v;
    res.delivery.push(...p.delivery);
    for (const k of Object.keys(res.latency)) res.latency[k].push(...p.latency[k]);
  }
  const lat = Object.fromEntries(Object.entries(res.latency).map(([k, v]) => [k, stat(v)]));
  const errTotal = Object.values(res.errors).reduce((a, b) => a + b, 0);
  console.log('\n================ SOAK RESULT ================');
  console.log(`simulated users            ${USERS.toLocaleString()}  (${POSTER_PCT}% post)${loads ? `, board of ${loads.toLocaleString()} loads` : ''}`);
  console.log(`requests served            ${res.counts.requests.toLocaleString()}  (${(res.counts.requests / SECONDS).toFixed(0)} req/s average)${posted != null ? `, loads posted ${posted}` : ''}`);
  console.log(`live connections           failed ${res.counts.sseFailed}, reconnects ${res.counts.reconnects}, frames delivered ${res.counts.frames.toLocaleString()}${serverSide ? `, peak open on server ${serverSide.peakConns.toLocaleString()}` : ''}`);
  console.log(`post -> browser delivery   ${JSON.stringify(stat(res.delivery))} ms`);
  console.log('latency seen by users (ms) ' + Object.entries(lat).map(([k, v]) => `${k}: p50 ${v.p50} / p95 ${v.p95} / p99 ${v.p99} (n=${v.n})`).join('\n                           '));
  if (serverSide) {
    console.log('server-side time (ms)      ' + Object.entries(serverSide.byKind).filter(([, v]) => v.length).map(([k, v]) => `${k}: p50 ${stat(v).p50} / p95 ${stat(v).p95} / p99 ${stat(v).p99} (n=${v.length})`).join('\n                           '));
    console.log(`API process                peak RSS ${serverSide.peakRss.toFixed(0)} MB, event-loop lag p99 peak ${serverSide.peakLag.toFixed(1)} ms`);
    console.log(`database                   peak active ${serverSide.peakActive} / connections ${serverSide.peakDbConns}, pool queue peak ${serverSide.peakWaiting}`);
    const buckets = new Map();
    for (const [t, d] of serverSide.timeline) { const k = Math.floor(t / 10000); (buckets.get(k) ?? buckets.set(k, []).get(k)).push(d); }
    console.log('server-side, every request, by 10 s window (first window = users arriving):');
    for (const [k, v] of [...buckets].sort((a, b) => a[0] - b[0])) { const x = v.sort((p, q) => p - q); console.log(`  +${String(k * 10).padStart(3)}s  n=${String(x.length).padStart(5)}  p50 ${quantile(x, 0.5).toFixed(0).padStart(4)}  p95 ${quantile(x, 0.95).toFixed(0).padStart(5)}  max ${x.at(-1).toFixed(0).padStart(5)}`); }
  }
  console.log(`errors                     ${JSON.stringify(res.errors)}`);
  console.log(errTotal === 0 ? '\nPASS: zero errors' : `\nNOTE: ${errTotal} errors (${(100 * errTotal / res.counts.requests).toFixed(2)}% of requests)`);
}

// External mode: drive an already-running server, e.g.
//   WEB_CONCURRENCY=4 npm run dev:fake-auth -- --seed 50000 --members 5000
//   SOAK_BASE=http://127.0.0.1:8080 SOAK_USERS=5000 npm run soak
async function external() {
  const parts = await runSwarms({ base: process.env.SOAK_BASE, cityIds: Array.from({ length: 150 }, (_, i) => i + 1), tokenPrefix: process.env.SOAK_TOKEN_PREFIX || 'dev' });
  report({ parts });
}

// =================================================================== server (parent, in-process mode)
async function main() {
  if (process.env.SOAK_BASE) return external();
  const { startTestEnv } = await import('../test/helpers.js');
  const { insertLoads, insertMembers, insertTrucks } = await import('./lib/generate.js');
  const env = await startTestEnv({
    DB_POOL_MAX: process.env.DB_POOL_MAX || '20', DB_STATEMENT_TIMEOUT_MS: '8000',
    COUNT_CACHE_MS: '5000', MEMBER_CACHE_MS: '10000', EVENT_BATCH_MS: '1000', SEARCH_CACHE_MS: '1500',
    RATE_LIMIT_PER_MIN: '1000000', WRITE_RATE_LIMIT_PER_MIN: '1000000',
    MAX_POSTS_PER_HOUR: '100000', MAX_ACTIVE_LOADS_PER_MEMBER: '100000',
  });
  try {
    console.log(`Seeding ${LOADS.toLocaleString()} loads, ${USERS.toLocaleString()} approved members ...`);
    const owners = await insertMembers(env.pool, { count: 100, prefix: 'seed' });
    await insertLoads(env.pool, { count: LOADS, owners, seed: 7, batch: 5000 });
    await insertTrucks(env.pool, { count: Math.round(LOADS / 5), owners, seed: 8, batch: 5000 });
    await env.pool.query(`INSERT INTO members (email, company, contact_name, phone, telegram, status, reviewed_at)
      SELECT 'soak' || g || '@example.com', 'Soak Co ' || g, 'Dispatcher', '+998 90 123 45 67', '@soak_' || g, 'approved', now() FROM generate_series(1, $1) g
      ON CONFLICT (email) DO NOTHING`, [USERS]);
    await env.pool.query('ANALYZE');
    const { rows: cities } = await env.pool.query("SELECT id FROM cities WHERE country IN ('UZ','KZ','RU','KG','TJ','TM','AZ','GE','AM','BY') ORDER BY id");

    const byKind = { search: [], stats: [], mine: [], post: [], other: [] };
    const timeline = []; const tStart = performance.now();
    const classify = (u, m) => (u.startsWith('/api/loads?') ? 'search' : u.startsWith('/api/stats') ? 'stats' : u.startsWith('/api/loads/mine') ? 'mine' : m === 'POST' ? 'post' : 'other');
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${env.app.server.address().port}`;
    // Socket-level timing (includes time queued inside this Node process); the long-lived SSE streams are skipped.
    env.app.server.on('request', (req, res) => {
      if (req.url.startsWith('/api/events')) return;
      const t0 = performance.now(); const kind = classify(req.url, req.method);
      res.on('finish', () => { const d = performance.now() - t0; byKind[kind].push(d); timeline.push([t0 - tStart, d]); });
    });
    const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
    const serverSide = { byKind, timeline, peakConns: 0, peakRss: 0, peakLag: 0, peakActive: 0, peakDbConns: 0, peakWaiting: 0 };
    const sampler = setInterval(async () => {
      serverSide.peakRss = Math.max(serverSide.peakRss, process.memoryUsage().rss / 1048576);
      serverSide.peakConns = Math.max(serverSide.peakConns, env.app.server._connections ?? 0);
      serverSide.peakLag = Math.max(serverSide.peakLag, lag.percentile(99) / 1e6); lag.reset();
      serverSide.peakWaiting = Math.max(serverSide.peakWaiting, env.pool.waitingCount);
      try {
        const { rows: [r] } = await env.pool.query("SELECT count(*) FILTER (WHERE state = 'active')::int AS active, count(*)::int AS total FROM pg_stat_activity WHERE datname = current_database()");
        serverSide.peakActive = Math.max(serverSide.peakActive, r.active); serverSide.peakDbConns = Math.max(serverSide.peakDbConns, r.total);
      } catch { /* ignore */ }
    }, 2000);

    console.log(`Releasing ${USERS.toLocaleString()} simulated browsers for ${SECONDS}s ...`);
    const parts = await runSwarms({ base, cityIds: cities.map((c) => c.id), tokenPrefix: 'test' });
    clearInterval(sampler);
    const { rows: [{ n: posted }] } = await env.pool.query("SELECT count(*)::int AS n FROM loads WHERE commodity IN ('Soak test cargo','Probe')");
    report({ parts, serverSide, loads: LOADS, posted });
  } finally {
    await env.close();
  }
}

if (process.argv.includes('--swarm')) swarm(); else main().catch((e) => { console.error(e); process.exit(1); });
