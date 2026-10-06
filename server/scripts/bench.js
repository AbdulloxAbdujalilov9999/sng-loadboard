// Load test against a real PostgreSQL (embedded, so it needs nothing installed):
//   npm run bench                 # 50,000 loads
//   BENCH_LOADS=200000 npm run bench
// Starts the real API, seeds data, hammers it with concurrent HTTP clients, and prints query plans.
import autocannon from 'autocannon';
import { startTestEnv, tokenFor } from '../test/helpers.js';
import { insertLoads, insertMembers, insertTrucks } from './lib/generate.js';

const N = Number(process.env.BENCH_LOADS || 50_000);
const DURATION = Number(process.env.BENCH_SECONDS || 8);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 48);

// Production-like settings: caches ON (the test harness turns them off), posting caps lifted so the
// write scenario measures throughput rather than the anti-spam limits.
const env = await startTestEnv({
  DB_POOL_MAX: process.env.DB_POOL_MAX || '20', DB_STATEMENT_TIMEOUT_MS: '8000',
  COUNT_CACHE_MS: '5000', MEMBER_CACHE_MS: '10000',
  MAX_POSTS_PER_HOUR: '100000000', MAX_ACTIVE_LOADS_PER_MEMBER: '100000000',
});
const fmtMs = (v) => `${v.toFixed(1)}ms`;

try {
  console.log(`\n== Seeding ${N.toLocaleString()} loads + ${(N / 5).toLocaleString()} trucks ==`);
  const t0 = Date.now();
  const owners = await insertMembers(env.pool, { count: 300, prefix: 'bench' });
  await insertLoads(env.pool, { count: N, owners, seed: 99, batch: 5000, onProgress: (d, t) => process.stdout.write(`\r  loads ${d.toLocaleString()}/${t.toLocaleString()}`) });
  await insertTrucks(env.pool, { count: Math.round(N / 5), owners, seed: 98, batch: 5000 });
  await env.pool.query('ANALYZE loads; ANALYZE trucks; ANALYZE members');
  const { rows: [size] } = await env.pool.query("SELECT pg_size_pretty(pg_total_relation_size('loads')) AS total, pg_size_pretty(pg_indexes_size('loads')) AS idx");
  console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(1)}s; loads table ${size.total} (indexes ${size.idx})`);

  await env.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${env.app.server.address().port}`;
  await env.approvedMember('viewer@bench.com', 'Bench Viewer');
  const headers = { authorization: `Bearer ${tokenFor('viewer@bench.com')}` };
  const api = env.as('viewer@bench.com');

  // Record the SQL the API actually runs so the plans below are the real ones.
  const captured = new Map();
  const origQuery = env.pool.query.bind(env.pool);
  env.pool.query = (text, params) => {
    if (globalThis.__scenario && typeof text === 'string' && /FROM (loads|trucks) \w WHERE/.test(text) && /ORDER BY/.test(text)) captured.set(globalThis.__scenario, { text, params });
    return origQuery(text, params);
  };

  const ids = {};
  for (const l of ['Tashkent, UZ', 'Moscow, RU', 'Almaty, KZ']) ids[l] = await env.cityId(l);

  // Walk to a cursor ~middle of the data set so the "deep page" scenario is genuinely deep.
  let cursor = null; let walked = 0;
  while (walked < Math.floor(N / 2)) {
    const r = (await api.get(`/api/loads?limit=100${cursor ? `&cursor=${cursor}` : ''}`)).json;
    walked += r.items.length; cursor = r.nextCursor;
    if (!cursor) break;
  }

  globalThis.__scenario = null;
  const scenarios = [
    ['feed: newest first (page 1 + count)', `/api/loads?limit=50`],
    [`feed: deep page (~row ${Math.floor(N / 2).toLocaleString()})`, `/api/loads?limit=50&cursor=${cursor}`],
    ['filter: equip=R sorted by rate', `/api/loads?equip=R&sort=rate&dir=asc&limit=50`],
    ['filter: sort by pickup date + date window', `/api/loads?sort=pickup&dir=asc&dateFrom=${new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10)}&limit=50`],
    ['radius: Tashkent +150km -> Moscow +100km', `/api/loads?origin=${ids['Tashkent, UZ']}&originRadius=150&dest=${ids['Moscow, RU']}&destRadius=100&limit=50`],
    ['search: text "fruit" (unindexed ILIKE)', `/api/loads?q=fruit&limit=50`],
    ['trucks: radius Almaty +300km', `/api/trucks?loc=${ids['Almaty, KZ']}&locRadius=300&limit=50`],
    ['directory: page 1', `/api/directory?limit=60`],
  ];

  console.log(`\n== HTTP load: ${CONNECTIONS} concurrent clients x ${DURATION}s per scenario (${N.toLocaleString()} loads) ==`);
  const rows = [];
  for (const [name, url] of scenarios) {
    globalThis.__scenario = name;
    const res = await autocannon({ url: base + url, connections: CONNECTIONS, duration: DURATION, headers, workers: 2 });
    rows.push({
      scenario: name, 'req/s': Math.round(res.requests.average), p50: fmtMs(res.latency.p50), p97_5: fmtMs(res.latency.p97_5),
      p99: fmtMs(res.latency.p99), max: fmtMs(res.latency.max), errors: res.errors + res.non2xx,
    });
  }
  console.table(rows);

  // Mixed read/write: 90% reads, 10% posting new loads while others read.
  console.log('== Mixed traffic: ~90% reads + ~10% posts ==');
  const post = JSON.stringify({ originCityId: ids['Almaty, KZ'], destCityId: ids['Tashkent, UZ'], equip: 'T', fp: 'Full', weightT: 20,
    pickupDate: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), rateUsd: 1500, commodity: 'bench', contactName: 'b',
    contactPhone: '+998 90 111 22 33', contactEmail: 'b@bench.com', contactTelegram: '@bench_bot' });
  // posting owner needs a non-limited quota: use many members round-robin via tokens
  const posters = owners.slice(0, 100).map((o) => ({ method: 'POST', path: '/api/loads', headers: { authorization: `Bearer ${tokenFor(o.email)}`, 'content-type': 'application/json' }, body: post }));
  const mixed = await autocannon({
    url: base, connections: CONNECTIONS, duration: DURATION, workers: 2,
    // ~90% reads / ~10% writes, writes spread over different members (a member's own posts are serialised on purpose)
    requests: [
      ...Array(18).fill(0).map((_, i) => ({ method: 'GET', path: ['/api/loads?limit=50', '/api/loads?equip=T&limit=50', `/api/loads?origin=${ids['Almaty, KZ']}&limit=50`][i % 3], headers })),
      posters[0], posters[1],
    ],
  });
  console.table([{ 'req/s': Math.round(mixed.requests.average), p50: fmtMs(mixed.latency.p50), p97_5: fmtMs(mixed.latency.p97_5), p99: fmtMs(mixed.latency.p99), errors: mixed.errors, non2xx: mixed.non2xx }]);

  console.log('== Query plans (real SQL from the API, EXPLAIN ANALYZE) ==');
  for (const [name, q] of captured) {
    const { rows: plan } = await origQuery(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${q.text}`, q.params);
    const lines = plan.map((r) => r['QUERY PLAN']);
    const keyLines = lines.filter((l) => /Scan|Execution Time|Sort|Limit/.test(l)).map((l) => l.trim()).slice(0, 4);
    console.log(`\n-- ${name}\n   ${keyLines.join('\n   ')}`);
  }
  const mem = process.memoryUsage();
  console.log(`\nAPI process memory: rss ${(mem.rss / 1048576).toFixed(0)} MB, heap ${(mem.heapUsed / 1048576).toFixed(0)} MB`);
} finally {
  await env.close();
}
