import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';

let env; let ids;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const MILES_100 = 161; // 100 miles in km
const TASHKENT = { nearLat: 41.3, nearLng: 69.24 };
const qs = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

before(async () => {
  env = await startTestEnv();
  ids = {};
  // Tashkent itself, Angren (~80 km) and Gulistan (~100 km) are inside 100 miles; Jizzakh (~195 km) and Samarkand (~270 km) are not
  for (const l of ['Tashkent, UZ', 'Angren, UZ', 'Gulistan, UZ', 'Jizzakh, UZ', 'Samarkand, UZ', 'Moscow, RU']) ids[l] = await env.cityId(l);
  await env.approvedMember('near@test.com', 'Near Co');
  const api = env.as('near@test.com');
  for (const from of ['Gulistan, UZ', 'Samarkand, UZ', 'Tashkent, UZ', 'Jizzakh, UZ', 'Angren, UZ']) {
    assert.equal((await api.post('/api/loads', validLoad(ids[from], ids['Moscow, RU'], { commodity: `from ${from}` }))).status, 201);
    assert.equal((await api.post('/api/trucks', { locCityId: ids[from], equip: 'T', capacityT: 20, availableFrom: day(1), contactPhone: '+998 71 200 11 22', destPref: `to-${from}` })).status, 201);
  }
});
after(async () => { await env.close(); });

test('loads near me: the 100-mile circle around a position, nearest first, with the distance', async () => {
  const api = env.as('near@test.com');
  const r = await api.get(`/api/loads?${qs({ ...TASHKENT, originRadius: MILES_100, sort: 'nearest', dir: 'asc' })}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((l) => l.originCity), ['Tashkent, UZ', 'Angren, UZ', 'Gulistan, UZ'], 'inside the circle, nearest first');
  assert.ok(r.json.items[0].dho <= 5 && r.json.items[1].dho > 60 && r.json.items[1].dho < 100 && r.json.items[2].dho < 161, `distances ${r.json.items.map((l) => l.dho)}`);
  assert.equal(r.json.total, 3);

  const small = await api.get(`/api/loads?${qs({ ...TASHKENT, originRadius: 40 })}`);
  assert.deepEqual(small.json.items.map((l) => l.originCity), ['Tashkent, UZ'], 'a smaller radius shrinks the circle');
  const big = await api.get(`/api/loads?${qs({ ...TASHKENT, originRadius: 322, sort: 'nearest', dir: 'asc' })}`);
  assert.deepEqual(big.json.items.map((l) => l.originCity), ['Tashkent, UZ', 'Angren, UZ', 'Gulistan, UZ', 'Jizzakh, UZ', 'Samarkand, UZ'], '200 miles reaches Samarkand too');

  // paging keeps the nearest-first order
  const p1 = await api.get(`/api/loads?${qs({ ...TASHKENT, originRadius: 322, sort: 'nearest', dir: 'asc', limit: 2 })}`);
  assert.equal(p1.json.items.length, 2);
  const p2 = await api.get(`/api/loads?${qs({ ...TASHKENT, originRadius: 322, sort: 'nearest', dir: 'asc', limit: 2, cursor: p1.json.nextCursor })}`);
  assert.deepEqual([...p1.json.items, ...p2.json.items].map((l) => l.originCity).slice(0, 4), ['Tashkent, UZ', 'Angren, UZ', 'Gulistan, UZ', 'Jizzakh, UZ']);

  // it combines with the other filters
  const t = await api.get(`/api/loads?${qs({ ...TASHKENT, originRadius: MILES_100, equip: 'R' })}`);
  assert.equal(t.json.items.length, 0);
});

test('trucks near me work the same way', async () => {
  const api = env.as('near@test.com');
  const r = await api.get(`/api/trucks?${qs({ ...TASHKENT, locRadius: MILES_100, sort: 'nearest', dir: 'asc' })}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((x) => x.locCity), ['Tashkent, UZ', 'Angren, UZ', 'Gulistan, UZ']);
  assert.ok(r.json.items.every((x) => typeof x.dho === 'number'));
  assert.deepEqual((await api.get(`/api/trucks?${qs({ ...TASHKENT, locRadius: 40 })}`)).json.items.map((x) => x.locCity), ['Tashkent, UZ']);
});

test('near me: a position needs both numbers, replaces the city filter, and is checked', async () => {
  const api = env.as('near@test.com');
  for (const bad of [{ nearLat: 41.3 }, { nearLng: 69.2 }, { nearLat: 95, nearLng: 10 }, { nearLat: 'x', nearLng: 1 }, { nearLat: 41.3, nearLng: 200 }]) {
    assert.equal((await api.get(`/api/loads?${qs(bad)}`)).status, 400, JSON.stringify(bad));
    assert.equal((await api.get(`/api/trucks?${qs(bad)}`)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await api.get(`/api/loads?${qs({ ...TASHKENT, origin: ids['Samarkand, UZ'] })}`)).status, 400, 'a position and a city are two answers to the same question');
  assert.equal((await api.get(`/api/trucks?${qs({ ...TASHKENT, loc: ids['Samarkand, UZ'] })}`)).status, 400);
  // "nearest" without a centre is just the newest first - never an error
  const none = await api.get('/api/loads?sort=nearest&dir=asc');
  assert.equal(none.status, 200);
  assert.ok(none.json.items.length >= 5);
  // a picked city also works as the centre for "nearest first"
  const city = await api.get(`/api/loads?${qs({ origin: ids['Tashkent, UZ'], originRadius: 322, sort: 'nearest', dir: 'asc' })}`);
  assert.equal(city.json.items[0].originCity, 'Tashkent, UZ');
  // the position is rounded (about 1 km): two nearly identical positions are the same search
  assert.equal((await api.get(`/api/loads?${qs({ nearLat: 41.30012, nearLng: 69.24049, originRadius: 40 })}`)).json.items.length, 1);
  // needs to be signed in like every search
  assert.equal((await env.anon().get(`/api/loads?${qs(TASHKENT)}`)).status, 401);
});
