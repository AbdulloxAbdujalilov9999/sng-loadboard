import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { insertLoads, insertMembers } from '../scripts/lib/generate.js';
import { haversineKm } from '../src/lib/geo.js';

let env; let ids;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  env = await startTestEnv();
  ids = {};
  for (const l of ['Tashkent, UZ', 'Moscow, RU', 'Almaty, KZ', 'Samarkand, UZ', 'Namangan, UZ', 'Andijan, UZ', 'Fergana, UZ', 'Bishkek, KG']) ids[l] = await env.cityId(l);
  await env.approvedMember('dias@test.com', 'KazTrans');
  await env.approvedMember('sardor@test.com', 'Valley Fresh');
});
after(async () => { await env.close(); });

test('create: server computes distance, snapshots company, rejects client-controlled fields', async () => {
  const api = env.as('dias@test.com');
  const res = await api.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']));
  assert.equal(res.status, 201);
  const l = res.json;
  assert.equal(l.company, 'KazTrans');
  assert.equal(l.mine, true);
  assert.equal(l.originCity, 'Almaty, KZ');
  // Almaty->Tashkent is ~810 km great-circle; road estimate = x1.2
  const gc = haversineKm(43.2220, 76.8512, 41.2995, 69.2401);
  assert.equal(l.distanceKm, Math.round(gc * 1.2));
  assert.ok(l.distanceKm > 700 && l.distanceKm < 900, `plausible road distance, got ${l.distanceKm}`);

  // The client must not be able to inject distance, owner, company, status, id...
  for (const extra of [{ distanceKm: 5 }, { ownerId: 1 }, { company: 'Evil' }, { status: 'active' }, { id: 7 }]) {
    const r = await api.post('/api/loads', { ...validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']), ...extra });
    assert.equal(r.status, 400, `rejects ${Object.keys(extra)[0]}`);
  }
});

test('create: validation errors are specific and nothing is stored', async () => {
  const api = env.as('dias@test.com');
  const T = ids['Tashkent, UZ']; const M = ids['Moscow, RU'];
  const before = (await env.pool.query('SELECT count(*)::int n FROM loads')).rows[0].n;
  const cases = [
    [{ weightT: 0 }, 'weightT'], [{ weightT: 500 }, 'weightT'], [{ equip: 'X' }, 'equip'], [{ fp: 'Half' }, 'fp'],
    [{ rateUsd: -5 }, 'rateUsd'], [{ commodity: '' }, 'commodity'], [{ commodity: 'x'.repeat(201) }, 'commodity'],
    [{ contactPhone: 'abc' }, 'contactPhone'], [{ contactEmail: 'not-an-email' }, 'contactEmail'],
    [{ contactTelegram: 'a b' }, 'contactTelegram'], [{ pickupDate: '2020-01-01' }, 'pickupDate'],
    [{ pickupDate: '2026-02-31' }, 'pickupDate'], [{ pickupDate: 'tomorrow' }, 'pickupDate'],
    [{ pickupDate: day(2), deliveryDate: day(1) }, 'deliveryDate'], [{ destCityId: T }, 'destCityId'],
    [{ originCityId: 999999 }, 'originCityId'], [{ pickupDate: day(900) }, 'pickupDate'],
  ];
  for (const [over, field] of cases) {
    const r = await api.post('/api/loads', validLoad(T, M, over));
    assert.equal(r.status, 400, `${JSON.stringify(over)} should be rejected`);
    const paths = (r.json.error.details ?? []).map((d) => d.path);
    assert.ok(paths.includes(field), `error points at ${field}, got ${JSON.stringify(r.json.error)}`);
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM loads')).rows[0].n, before);
  const malformed = await env.app.inject({ method: 'POST', url: '/api/loads', headers: { authorization: 'Bearer test:dias@test.com', 'content-type': 'application/json' }, payload: '{not json' });
  assert.equal(malformed.statusCode, 400);
});

test('edit & remove: only the owner of a load (or the platform owner)', async () => {
  const dias = env.as('dias@test.com'); const sardor = env.as('sardor@test.com'); const owner = env.as('owner@test.com');
  const made = (await dias.post('/api/loads', validLoad(ids['Tashkent, UZ'], ids['Moscow, RU']))).json;

  assert.equal((await sardor.patch(`/api/loads/${made.id}`, { rateUsd: 1 })).status, 403, 'other member cannot edit');
  assert.equal((await sardor.del(`/api/loads/${made.id}`)).status, 403, 'other member cannot delete');

  const upd = await dias.patch(`/api/loads/${made.id}`, { rateUsd: 3100, destCityId: ids['Samarkand, UZ'], commodity: 'Updated' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.rateUsd, 3100);
  assert.equal(upd.json.destCity, 'Samarkand, UZ');
  assert.ok(upd.json.distanceKm < 600, 'distance recomputed for the new destination');
  assert.equal((await dias.patch(`/api/loads/${made.id}`, { distanceKm: 1 })).status, 400);
  assert.equal((await dias.patch(`/api/loads/${made.id}`, { destCityId: ids['Tashkent, UZ'] })).status, 400, 'origin==dest rejected on edit too');

  assert.equal((await owner.patch(`/api/loads/${made.id}`, { commodity: 'Moderated' })).status, 200, 'platform owner may moderate');

  assert.equal((await dias.del(`/api/loads/${made.id}`)).status, 204);
  assert.equal((await dias.del(`/api/loads/${made.id}`)).status, 404, 'already removed');
  assert.equal((await dias.patch(`/api/loads/${made.id}`, { rateUsd: 5 })).status, 404);
  const { rows: [row] } = await env.pool.query('SELECT status, closed_at FROM loads WHERE id = $1', [made.id]);
  assert.equal(row.status, 'closed', 'soft delete keeps history');
  assert.ok(row.closed_at);
  const feed = (await sardor.get('/api/loads?limit=100')).json.items;
  assert.ok(!feed.some((x) => x.id === made.id), 'removed load is gone from the board');
});

test('quotas: per-member active cap and hourly posting cap', async () => {
  const capped = await startTestEnv({ MAX_ACTIVE_LOADS_PER_MEMBER: '3', MAX_POSTS_PER_HOUR: '100' });
  try {
    await capped.approvedMember('cap@test.com');
    const api = capped.as('cap@test.com');
    const A = await capped.cityId('Almaty, KZ'); const B = await capped.cityId('Bishkek, KG');
    for (let i = 0; i < 3; i += 1) assert.equal((await api.post('/api/loads', validLoad(A, B))).status, 201);
    const over = await api.post('/api/loads', validLoad(A, B));
    assert.equal(over.status, 429);
    assert.equal(over.json.error.code, 'quota_exceeded');
    // removing one frees a slot
    const mine = (await api.get('/api/loads/mine')).json.items;
    await api.del(`/api/loads/${mine[0].id}`);
    assert.equal((await api.post('/api/loads', validLoad(A, B))).status, 201);
  } finally { await capped.close(); }
});

test('concurrent posts never exceed the quota (advisory lock)', async () => {
  const capped = await startTestEnv({ MAX_ACTIVE_LOADS_PER_MEMBER: '5' });
  try {
    await capped.approvedMember('race@test.com');
    const api = capped.as('race@test.com');
    const A = await capped.cityId('Almaty, KZ'); const B = await capped.cityId('Bishkek, KG');
    const results = await Promise.all(Array.from({ length: 20 }, () => api.post('/api/loads', validLoad(A, B))));
    const created = results.filter((r) => r.status === 201).length;
    assert.equal(created, 5, 'exactly the quota gets through');
    assert.equal(results.filter((r) => r.status === 429).length, 15);
  } finally { await capped.close(); }
});

// ---------------------------------------------------------------- search
test('search: filters (equip, F/P, dates, weight, rate, distance, text) combine correctly', async () => {
  const api = env.as('dias@test.com');
  const T = ids['Tashkent, UZ']; const M = ids['Moscow, RU']; const A = ids['Almaty, KZ'];
  await env.pool.query("DELETE FROM loads");
  const mk = (over) => api.post('/api/loads', validLoad(T, M, over));
  await mk({ equip: 'R', fp: 'Full', weightT: 20, rateUsd: 3000, pickupDate: day(2), commodity: 'Fresh Peaches' });
  await mk({ equip: 'T', fp: 'Partial', weightT: 8, rateUsd: 1400, pickupDate: day(6), commodity: 'Packaging' });
  await mk({ equip: 'F', fp: 'Full', weightT: 24, rateUsd: 1350, pickupDate: day(10), commodity: 'Steel rods', destCityId: A });
  await mk({ equip: 'T', fp: 'Full', weightT: 22, rateUsd: 3500, pickupDate: day(4), commodity: '100% cotton_yarn' });
  const get = async (qs) => (await api.get(`/api/loads?${qs}`)).json;

  assert.equal((await get('')).total, 4);
  assert.equal((await get('equip=R')).total, 1);
  assert.equal((await get('equip=R,F')).total, 2);
  assert.equal((await get('fp=Partial')).total, 1);
  assert.equal((await get(`dateFrom=${day(3)}&dateTo=${day(7)}`)).total, 2);
  assert.equal((await get('minWeight=21')).total, 2);
  assert.equal((await get('maxWeight=9')).total, 1);
  assert.equal((await get('minRate=3000')).total, 2);
  assert.equal((await get('maxDistance=1500')).total, 1, 'only the Tashkent->Almaty load is short');
  assert.equal((await get('q=peach')).total, 1, 'text search is case-insensitive');
  assert.equal((await get('q=100%25')).total, 1, 'LIKE wildcards are escaped');
  assert.equal((await get('q=cotton_yarn')).total, 1);
  // Only the "100% cotton_yarn" row literally contains '%'; if it acted as a wildcard all 4 would match.
  assert.equal((await get('q=0%25')).total, 1, '% is matched literally ("100% cotton")');
  assert.equal((await get('q=n_y')).total, 1, '_ is matched literally ("cotton_yarn"), not as a one-char wildcard');
  assert.equal((await get('q=%25%25')).total, 0, 'a double % is not a match-everything wildcard');
  assert.equal((await api.get('/api/loads?q=a')).status, 400, 'one-character searches are refused (index needs 2+)');
  assert.equal((await get('equip=T&fp=Full&minRate=3000')).total, 1);

  assert.equal((await api.get('/api/loads?equip=ZZ')).status, 400);
  assert.equal((await api.get('/api/loads?limit=1000')).status, 400);
  assert.equal((await api.get('/api/loads?sort=password')).status, 400, 'sort is a whitelist');
  assert.equal((await api.get('/api/loads?bogus=1')).status, 400, 'unknown params rejected');
  assert.equal((await api.get('/api/loads?q=x%27%3B+DROP+TABLE+loads%3B--')).status, 200, 'injection attempt is just text');
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM loads')).rows[0].n, 4, 'table intact');
});

test('search: past-pickup loads are hidden from the board but still manageable by their owner', async () => {
  const api = env.as('dias@test.com');
  await env.pool.query("DELETE FROM loads");
  const made = (await api.post('/api/loads', validLoad(ids['Tashkent, UZ'], ids['Moscow, RU']))).json;
  await env.pool.query("UPDATE loads SET pickup_date = current_date - 5 WHERE id = $1", [made.id]);
  assert.equal((await api.get('/api/loads')).json.total, 0, 'stale load not on the board');
  assert.equal((await api.get('/api/loads/mine')).json.items.length, 1, 'but listed in "mine"');
  assert.equal((await api.del(`/api/loads/${made.id}`)).status, 204);
});

test('search: radius ("deadhead") matches exactly the cities within range, and reports the distance', async () => {
  const api = env.as('dias@test.com');
  await env.pool.query("DELETE FROM loads");
  const M = ids['Moscow, RU'];
  const origins = ['Tashkent, UZ', 'Samarkand, UZ', 'Namangan, UZ', 'Andijan, UZ', 'Fergana, UZ', 'Almaty, KZ'];
  for (const o of origins) await api.post('/api/loads', validLoad(ids[o], M));

  const near = async (radius) => (await api.get(`/api/loads?origin=${ids['Andijan, UZ']}&originRadius=${radius}&limit=100`)).json.items;
  const labels = (items) => items.map((i) => i.originCity).sort();

  // Compute the expected answer independently with the JS haversine.
  const coords = (await env.pool.query("SELECT label, lat, lng FROM cities WHERE label = ANY($1)", [origins])).rows;
  const andijan = (await env.pool.query("SELECT lat, lng FROM cities WHERE label = 'Andijan, UZ'")).rows[0];
  for (const radius of [0, 30, 60, 100, 300, 700]) {
    const expected = coords.filter((c) => haversineKm(andijan.lat, andijan.lng, c.lat, c.lng) <= radius + 0.01).map((c) => c.label).sort();
    assert.deepEqual(labels(await near(radius)), expected, `radius ${radius} km`);
  }
  const items = await near(100);
  const self = items.find((i) => i.originCity === 'Andijan, UZ');
  assert.equal(self.dho, 0);
  const fergana = items.find((i) => i.originCity === 'Fergana, UZ');
  assert.ok(fergana.dho > 50 && fergana.dho < 80, `Andijan-Fergana ~65km, got ${fergana.dho}`);
  assert.equal(items[0].dhd, null, 'dhd only present when a destination filter is used');

  const both = (await api.get(`/api/loads?origin=${ids['Andijan, UZ']}&originRadius=500&dest=${M}&destRadius=50`)).json;
  assert.ok(both.total >= 5);
  assert.ok(both.items.every((i) => i.dho !== null && i.dhd !== null));
  assert.equal((await api.get('/api/loads?origin=999999')).status, 400, 'unknown city');
});

// ---------------------------------------------------------------- pagination
test('pagination: every sort x direction walks the full set exactly once, in order, with ties', async () => {
  await env.pool.query('DELETE FROM loads');
  const owners = await insertMembers(env.pool, { count: 6, prefix: 'pg' });
  await insertLoads(env.pool, { count: 650, owners, seed: 42 });
  const api = env.as('dias@test.com');

  const keyOf = {
    created: (l) => l.id, pickup: (l) => l.pickupDate, origin: (l) => l.originCity, dest: (l) => l.destCity, equip: (l) => l.equip,
    weight: (l) => l.weightT, distance: (l) => l.distanceKm, rate: (l) => l.rateUsd, company: (l) => l.company,
  };
  const cmp = (a, b) => (typeof a === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : a - b);

  for (const sort of Object.keys(keyOf)) {
    for (const dir of ['asc', 'desc']) {
      const seen = new Set(); const all = []; let cursor = null; let pages = 0; let total = null;
      do {
        const res = (await api.get(`/api/loads?sort=${sort}&dir=${dir}&limit=37${cursor ? `&cursor=${cursor}` : ''}`)).json;
        if (pages === 0) total = res.total; else assert.equal(res.total, undefined, 'total only on the first page');
        for (const l of res.items) { assert.ok(!seen.has(l.id), `${sort}/${dir}: duplicate id ${l.id}`); seen.add(l.id); all.push(l); }
        cursor = res.nextCursor; pages += 1;
        assert.ok(pages < 100, 'pagination terminates');
      } while (cursor);
      assert.equal(all.length, 650, `${sort}/${dir}: visited every row once (got ${all.length})`);
      assert.equal(total, 650);
      for (let i = 1; i < all.length; i += 1) {
        const c = cmp(keyOf[sort](all[i - 1]), keyOf[sort](all[i]));
        assert.ok(dir === 'asc' ? c <= 0 : c >= 0, `${sort}/${dir}: out of order at ${i}`);
      }
    }
  }
});

test('pagination: filters stay applied across pages and bad cursors are rejected', async () => {
  const api = env.as('dias@test.com');
  const first = (await api.get('/api/loads?equip=R&sort=rate&dir=asc&limit=20')).json;
  const expected = (await env.pool.query("SELECT count(*)::int n FROM loads WHERE equip = 'R' AND status = 'active' AND pickup_date >= current_date - 1")).rows[0].n;
  assert.equal(first.total, expected);
  const second = (await api.get(`/api/loads?equip=R&sort=rate&dir=asc&limit=20&cursor=${first.nextCursor}`)).json;
  assert.ok(second.items.every((l) => l.equip === 'R'));
  assert.ok(second.items[0].rateUsd >= first.items.at(-1).rateUsd);

  for (const cursor of ['garbage', Buffer.from('[1]').toString('base64url'), Buffer.from('["abc","x"]').toString('base64url'),
    Buffer.from(JSON.stringify(["1'; DROP TABLE loads;--", 5])).toString('base64url')]) {
    const r = await api.get(`/api/loads?sort=rate&cursor=${cursor}`);
    assert.equal(r.status, 400, `cursor ${cursor.slice(0, 12)} rejected`);
  }
  assert.equal((await env.pool.query('SELECT count(*)::int n FROM loads')).rows[0].n, 650, 'table intact');
});

test('total is capped (10,000+) so counting never becomes the slow part', async () => {
  await env.pool.query('DELETE FROM loads');
  const owners = (await env.pool.query("SELECT * FROM members WHERE email LIKE 'pg%@example.com'")).rows;
  await insertLoads(env.pool, { count: 10_300, owners, seed: 7, batch: 3000 });
  const res = (await env.as('dias@test.com').get('/api/loads?limit=5')).json;
  assert.equal(res.total, 10_000);
  assert.equal(res.totalCapped, true);
  assert.equal(res.items.length, 5);
});

test('validation errors carry stable codes + human messages (no raw zod text)', async () => {
  const api = env.as('dias@test.com');
  const base = validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']);
  const codeFor = async (over, path) => {
    const r = await api.post('/api/loads', { ...base, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    const d = r.json.error.details.find((x) => x.path === path);
    assert.ok(d, `${path} flagged: ${JSON.stringify(r.json.error.details)}`);
    assert.ok(!/expected|received|Too small|Invalid input/i.test(d.message), `human message, got "${d.message}"`);
    return d;
  };
  assert.equal((await codeFor({ weightT: 0 }, 'weightT')).code, 'num_positive');
  assert.equal((await codeFor({ weightT: 500 }, 'weightT')).code, 'num_max');
  assert.equal((await codeFor({ weightT: 'abc' }, 'weightT')).code, 'number');
  assert.equal((await codeFor({ commodity: '' }, 'commodity')).code, 'required');
  assert.equal((await codeFor({ contactPhone: '!!' }, 'contactPhone')).code, 'phone');
  assert.equal((await codeFor({ contactTelegram: 'x' }, 'contactTelegram')).code, 'telegram');
  assert.equal((await codeFor({ contactEmail: 'nope' }, 'contactEmail')).code, 'email');
  assert.equal((await codeFor({ equip: 'Q' }, 'equip')).code, 'choice');
  assert.equal((await codeFor({ pickupDate: '2026-02-31' }, 'pickupDate')).code, 'date_real');
  assert.equal((await codeFor({ destCityId: base.originCityId }, 'destCityId')).code, 'dest_same_as_origin');
  const max = await codeFor({ commodity: 'x'.repeat(300) }, 'commodity');
  assert.equal(max.code, 'text_max'); assert.equal(max.params.max, 200);
  assert.equal((await codeFor({ deliveryDate: day(0), pickupDate: day(3) }, 'deliveryDate')).code, 'delivery_before_pickup');
});

test('GET /api/stats: approved members only, counts live loads and trucks', async () => {
  assert.equal((await env.as('stranger@test.com').get('/api/stats')).status, 403);
  const r = await env.as('dias@test.com').get('/api/stats');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.loads, 'number');
  assert.equal(typeof r.json.trucks, 'number');
  assert.ok(r.json.loads >= 1, 'sees the loads created by earlier tests');
});
