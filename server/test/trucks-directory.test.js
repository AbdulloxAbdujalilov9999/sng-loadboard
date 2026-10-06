import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';
import { insertMembers, insertTrucks } from '../scripts/lib/generate.js';

let env; let ids;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const truck = (locCityId, over = {}) => ({ locCityId, equip: 'T', capacityT: 22, availableFrom: day(1), contactPhone: '+998 71 200 11 22', contactTelegram: '@orient_trans', ...over });

before(async () => {
  env = await startTestEnv();
  ids = {};
  for (const l of ['Tashkent, UZ', 'Samarkand, UZ', 'Almaty, KZ', 'Bishkek, KG', 'Andijan, UZ']) ids[l] = await env.cityId(l);
  await env.approvedMember('orient@test.com', 'Orient Trans');
  await env.approvedMember('manas@test.com', 'Manas Trucking');
});
after(async () => { await env.close(); });

test('post a truck: stored with owner, location snapshot and the end date that used to be dropped', async () => {
  const api = env.as('orient@test.com');
  const res = await api.post('/api/trucks', truck(ids['Samarkand, UZ'], {
    destPref: 'Moscow, RU', availableTo: day(9), minRateUsd: 2500, hasTir: true, hasGps: true, volumeM3: 92 }));
  assert.equal(res.status, 201);
  const t = res.json;
  assert.equal(t.locCity, 'Samarkand, UZ');
  assert.equal(t.company, 'Orient Trans');
  assert.equal(t.availableTo, day(9));
  assert.equal(t.minRateUsd, 2500);
  assert.equal(t.hasTir, true);
  assert.equal(t.hasAdr, false);
  assert.equal(t.mine, true);
  const blank = (await api.post('/api/trucks', truck(ids['Samarkand, UZ'], { destPref: '   ' }))).json;
  assert.equal(blank.destPref, 'Anywhere', 'blank destination means anywhere');
  assert.equal(blank.minRateUsd, null, 'no min rate = negotiable');
});

test('post a truck: validation', async () => {
  const api = env.as('orient@test.com');
  const S = ids['Samarkand, UZ'];
  for (const [over, field] of [[{ capacityT: 0 }, 'capacityT'], [{ equip: 'Q' }, 'equip'], [{ availableFrom: '2020-01-01' }, 'availableFrom'],
    [{ availableFrom: day(5), availableTo: day(2) }, 'availableTo'], [{ contactPhone: '!!' }, 'contactPhone'], [{ locCityId: 424242 }, 'locCityId']]) {
    const r = await api.post('/api/trucks', truck(S, over));
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.ok((r.json.error.details ?? []).some((d) => d.path === field), `points at ${field}: ${JSON.stringify(r.json.error)}`);
  }
  assert.equal((await api.post('/api/trucks', { ...truck(S), ownerId: 1 })).status, 400, 'no mass assignment');
});

test('search trucks: radius, equipment, destination, availability date', async () => {
  const manas = env.as('manas@test.com');
  await manas.post('/api/trucks', truck(ids['Bishkek, KG'], { equip: 'F', destPref: 'Anywhere Russia', capacityT: 25 }));
  await manas.post('/api/trucks', truck(ids['Almaty, KZ'], { equip: 'R', destPref: 'Tashkent / Samarkand' }));
  const api = env.as('orient@test.com');
  const get = async (qs) => (await api.get(`/api/trucks?${qs}`)).json;

  assert.equal((await get('')).total, 4);
  assert.equal((await get('equip=F')).total, 1);
  assert.equal((await get('minCapacity=24')).total, 1);
  const near = await get(`loc=${ids['Samarkand, UZ']}&locRadius=50`);
  assert.equal(near.total, 2, 'two Samarkand trucks within 50 km');
  assert.ok(near.items.every((t) => t.dho === 0));
  // Expected result computed independently with the JS haversine (no guessing at geography).
  const { haversineKm } = await import('../src/lib/geo.js');
  const origin = (await env.pool.query("SELECT lat, lng FROM cities WHERE label = 'Andijan, UZ'")).rows[0];
  const all = (await env.pool.query("SELECT loc_lat, loc_lng FROM trucks WHERE status = 'active'")).rows;
  for (const radius of [100, 300, 400, 500, 900]) {
    const want = all.filter((t) => haversineKm(origin.lat, origin.lng, t.loc_lat, t.loc_lng) <= radius + 0.01).length;
    assert.equal((await get(`loc=${ids['Andijan, UZ']}&locRadius=${radius}`)).total, want, `radius ${radius} km from Andijan`);
  }
  // "Anywhere"-style trucks always match a destination search (old behaviour kept)
  const toMoscow = await get('dest=moscow');
  assert.ok(toMoscow.items.some((t) => t.destPref === 'Moscow, RU'));
  assert.ok(toMoscow.items.some((t) => /^any/i.test(t.destPref)));
  assert.ok(!toMoscow.items.some((t) => t.destPref === 'Tashkent / Samarkand'));
  assert.equal((await get(`availableOn=${day(40)}`)).total, 0, 'nothing is available that far out');
  assert.equal((await get(`availableOn=${day(2)}`)).total, 4);
});

test('trucks expire by themselves (end date, else 30 days) but stay manageable', async () => {
  const api = env.as('orient@test.com');
  const mk = async (over) => (await api.post('/api/trucks', truck(ids['Tashkent, UZ'], over))).json;
  const withEnd = await mk({ availableFrom: day(0), availableTo: day(0) });
  const noEnd = await mk({ availableFrom: day(0) });
  const seen = async () => (await api.get('/api/trucks?limit=100')).json.items.map((t) => t.id);
  assert.ok((await seen()).includes(withEnd.id) && (await seen()).includes(noEnd.id));
  await env.pool.query("UPDATE trucks SET available_from = current_date - 6, available_to = current_date - 2 WHERE id = $1", [withEnd.id]);
  await env.pool.query("UPDATE trucks SET available_from = current_date - 31 WHERE id = $1", [noEnd.id]);
  const after = await seen();
  assert.ok(!after.includes(withEnd.id), 'explicit end date passed -> off the board');
  assert.ok(!after.includes(noEnd.id), 'no end date: auto-expires 30 days after it became available');
  assert.ok((await api.get('/api/trucks/mine')).json.items.some((t) => t.id === withEnd.id), 'owner can still remove it');
});

test('remove a truck: owner only; sorting & pagination by every key', async () => {
  const orient = env.as('orient@test.com'); const manas = env.as('manas@test.com');
  const mineT = (await orient.get('/api/trucks/mine')).json.items[0];
  assert.equal((await manas.del(`/api/trucks/${mineT.id}`)).status, 403);
  assert.equal((await orient.del(`/api/trucks/${mineT.id}`)).status, 204);
  assert.equal((await orient.del(`/api/trucks/${mineT.id}`)).status, 404);

  await env.pool.query('DELETE FROM trucks');
  const owners = await insertMembers(env.pool, { count: 5, prefix: 'tk' });
  await insertTrucks(env.pool, { count: 420, owners, seed: 5 });
  const keyOf = { created: (t) => t.id, available: (t) => t.availableFrom, loc: (t) => t.locCity, equip: (t) => t.equip,
    capacity: (t) => t.capacityT, rate: (t) => t.minRateUsd ?? 0 };
  const cmp = (a, b) => (typeof a === 'string' ? (a < b ? -1 : a > b ? 1 : 0) : a - b);
  const expected = (await env.pool.query("SELECT count(*)::int n FROM trucks WHERE status='active' AND expires_on >= current_date")).rows[0].n;
  for (const sort of Object.keys(keyOf)) {
    for (const dir of ['asc', 'desc']) {
      const seen = new Set(); const all = []; let cursor = null;
      do {
        const res = (await orient.get(`/api/trucks?sort=${sort}&dir=${dir}&limit=41${cursor ? `&cursor=${cursor}` : ''}`)).json;
        for (const t of res.items) { assert.ok(!seen.has(t.id), `${sort}/${dir} duplicate`); seen.add(t.id); all.push(t); }
        cursor = res.nextCursor;
      } while (cursor);
      assert.equal(all.length, expected, `${sort}/${dir} visits every row once`);
      for (let i = 1; i < all.length; i += 1) {
        const c = cmp(keyOf[sort](all[i - 1]), keyOf[sort](all[i]));
        assert.ok(dir === 'asc' ? c <= 0 : c >= 0, `${sort}/${dir} order at ${i}`);
      }
    }
  }
});

// ------------------------------------------------------------ directory
test('directory: approved members only, searchable, paginated, owner excluded, no private fields', async () => {
  await env.pool.query("DELETE FROM members WHERE email LIKE 'tk%'");
  const api = env.as('orient@test.com');
  await env.pool.query("UPDATE members SET location = 'Almaty, KZ', tir_carnet = 'TIR-KZ 98214', routes = 'KZ <-> RU' WHERE email = 'manas@test.com'");
  await env.as('newbie@gmail.com').post('/api/me/access-request', { company: 'Pending Co', phone: '+998 90 000 00 00', telegram: '@pending_co' });
  await env.as('owner@test.com').get('/api/me'); // provisions the owner row

  const all = (await api.get('/api/directory')).json;
  const names = all.items.map((i) => i.company);
  assert.ok(names.includes('Manas Trucking') && names.includes('Orient Trans'));
  assert.ok(!names.includes('Pending Co'), 'pending requests are not listed');
  assert.ok(!names.includes('SNG ONE Platform'), 'the owner account is not listed');
  assert.deepEqual(names, [...names].sort(), 'sorted by company');
  assert.ok(!('firebaseUid' in all.items[0]) && !('status' in all.items[0]) && !('role' in all.items[0]));

  assert.equal((await api.get('/api/directory?q=tir-kz')).json.total, 1);
  assert.equal((await api.get('/api/directory?q=almaty')).json.items[0].company, 'Manas Trucking');
  assert.equal((await api.get('/api/directory?q=%25')).json.total, 0, 'wildcards escaped');

  const owners = await insertMembers(env.pool, { count: 130, prefix: 'dir' });
  void owners;
  const walked = new Set(); let cursor = null; let pages = 0;
  do {
    const r = (await api.get(`/api/directory?limit=25${cursor ? `&cursor=${cursor}` : ''}`)).json;
    r.items.forEach((i) => { assert.ok(!walked.has(i.id)); walked.add(i.id); });
    cursor = r.nextCursor; pages += 1;
  } while (cursor);
  assert.equal(walked.size, (await env.pool.query("SELECT count(*)::int n FROM members WHERE status='approved' AND role='member'")).rows[0].n);
  assert.ok(pages >= 6);

  assert.equal((await env.as('newbie@gmail.com').get('/api/directory')).status, 403, 'pending users cannot read it');
});

// ------------------------------------------------------------ cities
test('cities: autocomplete by English or Russian name, label, and prefix ranking', async () => {
  const api = env.as('orient@test.com');
  const q = async (s) => (await api.get(`/api/cities?q=${encodeURIComponent(s)}`)).json.items.map((c) => c.label);
  assert.equal((await q('tashkent'))[0], 'Tashkent, UZ');
  assert.equal((await q('Ташкент'))[0], 'Tashkent, UZ', 'Russian name works');
  assert.equal((await q('Tashkent, UZ'))[0], 'Tashkent, UZ', 'full label works');
  assert.deepEqual(await q('Tashkent, KZ'), [], 'country part narrows the search');
  const m = await q('mo');
  assert.ok(m[0].toLowerCase().startsWith('mo'), 'prefix matches rank first');
  assert.ok((await q('')).length > 0 && (await q('')).length <= 8, 'empty query lists the first few');
  assert.equal((await api.get('/api/cities?q=a&limit=100')).status, 400);
  assert.deepEqual(await q("x'; DROP TABLE cities;--"), []);
  assert.ok((await env.pool.query('SELECT count(*)::int n FROM cities')).rows[0].n > 150);
  const c = (await api.get('/api/cities?q=almaty')).json.items[0];
  assert.deepEqual(Object.keys(c).sort(), ['country', 'id', 'label', 'lat', 'lng', 'name', 'nameRu']);
});
