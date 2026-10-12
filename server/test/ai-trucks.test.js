import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { createHeuristicParser } from '../src/lib/ai/heuristic.js';

const today = new Date().toISOString().slice(0, 10);
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const TRUCK_POSTS = `
🇺🇿САМАРКАНД → 🇷🇺МОСКВА
ТЕНТ 20т 86 куб
TIR GPS
+998901112233



🇺🇿 Xorazm
🇷🇺 РОССИЯ
РЕФ 22 тонн
свободен
+998 90 555 44 33



🇰🇿 АЛМАТЫ
ФУРГОН 10т
ADR боковая загрузка
+77011234567
`;

let env;
before(async () => {
  env = await startTestEnv({}, { ai: createHeuristicParser() });
  await env.approvedMember('carrier@test.com', 'Carrier Co');
});
after(async () => { await env.close(); });

test('parse-trucks: members only; one draft per pasted truck with city, trailer, capacity, features and phone', async () => {
  assert.equal((await env.as('nobody@test.com').post('/api/ai/parse-trucks', { text: TRUCK_POSTS })).status, 403);
  const r = await env.as('carrier@test.com').post('/api/ai/parse-trucks', { text: TRUCK_POSTS });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [a, b, c] = r.json.trucks;
  assert.equal(r.json.trucks.length, 3);

  assert.equal(a.locCity, 'Samarkand, UZ');
  assert.equal(a.destPref, 'МОСКВА');
  assert.equal(a.equip, 'T');
  assert.equal(a.capacityT, 20);
  assert.equal(a.volumeM3, 86);
  assert.equal(a.hasTir, true); assert.equal(a.hasGps, true); assert.equal(a.hasAdr, false);
  assert.equal(a.contactPhone, '+998901112233');
  assert.ok(a.flags.includes('date'), 'no date in the text -> flagged, defaults to today');
  assert.equal(a.availableFrom, today);

  assert.equal(b.locCity, 'Urgench, UZ', 'a region ("Xorazm") becomes its main city');
  assert.equal(b.destPref, 'РОССИЯ');
  assert.equal(b.equip, 'R');
  assert.equal(b.capacityT, 22);
  assert.equal(b.availableFrom, today, '"свободен" = free now');
  assert.ok(!b.flags.includes('date'));

  assert.equal(c.locCity, 'Almaty, KZ');
  assert.equal(c.equip, 'V'); assert.equal(c.hasAdr, true); assert.equal(c.sideLoading, true);
  assert.equal(c.volumeM3, null);
});

test('parse-trucks: model output is verified, never trusted', async () => {
  const hostile = {
    name: 'fake',
    async parseTrucks() {
      return { trucks: [
        { location: { text: 'Бухоро', city: 'Bukhara', country: 'UZ' }, destinationText: 'x'.repeat(300), equipment: ['T', 'ROCKET'], capacityT: 9999, volumeM3: 99999,
          availableFrom: '2020-01-01', availableTo: '2019-01-01', minRateUsd: -3, hasTir: 'yes', notes: 'n'.repeat(900), phone: '+998 90 123 45 67', evil: '<script>' },
        { location: { text: 'Narnia', city: 'Narnia', country: 'XX' }, equipment: [], notes: '' },
      ] };
    },
  };
  const e2 = await startTestEnv({}, { ai: hostile });
  try {
    await e2.approvedMember('m@test.com', 'M Co');
    const r = await e2.as('m@test.com').post('/api/ai/parse-trucks', { text: 'some pasted text here' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [a, b] = r.json.trucks;
    assert.equal(a.locCity, 'Bukhara, UZ');
    assert.equal(a.capacityT, 20); assert.equal(a.volumeM3, null);
    assert.equal(a.availableFrom, today, 'a date in the past is replaced');
    assert.equal(a.availableTo, null);
    assert.equal(a.minRateUsd, null);
    assert.equal(a.hasTir, false, 'only real booleans count');
    assert.ok(a.destPref.length <= 120 && a.notes.length <= 500);
    assert.equal(a.evil, undefined);
    assert.equal(b.locCityId, null);
    assert.ok(b.flags.includes('location'));
    // the draft still has to pass the normal posting rules
    const ok = await e2.as('m@test.com').post('/api/trucks', { locCityId: a.locCityId, destPref: a.destPref, equip: a.equip, capacityT: a.capacityT, availableFrom: a.availableFrom, contactPhone: a.contactPhone, contactTelegram: '@m_truck' });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
  } finally { await e2.close(); }

  const off = await startTestEnv({}, { ai: { name: 'loads-only', async parseLoads() { return { loads: [] }; } } });
  try {
    await off.approvedMember('m@test.com');
    assert.equal((await off.as('m@test.com').post('/api/ai/parse-trucks', { text: 'some pasted text here' })).json.error.code, 'ai_unavailable');
  } finally { await off.close(); }
});

test('bulk trucks: all-or-nothing, quotas for the whole batch, notes stored and returned', async () => {
  const api = env.as('carrier@test.com');
  const sam = await env.cityId('Samarkand, UZ'); const mos = await env.cityId('Moscow, RU');
  const one = { locCityId: sam, destPref: 'Moscow', equip: 'T', capacityT: 20, availableFrom: day(1), contactPhone: '+998 90 123 45 67', contactTelegram: '@carrier_x', notes: 'свободна · TIR' };
  const r = await api.post('/api/trucks/bulk', { trucks: [one, { ...one, locCityId: mos, equip: 'R' }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.items[0].notes, 'свободна · TIR');
  assert.equal(r.json.items[0].mine, true);
  assert.ok((await api.get('/api/trucks/mine')).json.items.every((t) => t.notes === 'свободна · TIR'));

  const before = (await api.get('/api/trucks/mine')).json.items.length;
  const bad = await api.post('/api/trucks/bulk', { trucks: [one, { ...one, locCityId: 999999 }, one] });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error.details.some((d) => d.path === 'trucks.1.locCityId'), JSON.stringify(bad.json.error.details));
  assert.equal((await api.get('/api/trucks/mine')).json.items.length, before, 'nothing half-posted');
  assert.equal((await api.post('/api/trucks/bulk', { trucks: [] })).status, 400);
  assert.equal((await api.post('/api/trucks/bulk', { trucks: Array.from({ length: 51 }, () => one) })).status, 400);

  const capped = await startTestEnv({ MAX_ACTIVE_TRUCKS_PER_MEMBER: '3' });
  try {
    await capped.approvedMember('c@test.com');
    const c = capped.as('c@test.com');
    const mk = { ...one, locCityId: await capped.cityId('Samarkand, UZ') };
    assert.equal((await c.post('/api/trucks/bulk', { trucks: [mk, mk] })).status, 201);
    assert.equal((await c.post('/api/trucks/bulk', { trucks: [mk, mk] })).status, 429, 'would exceed the limit as a whole');
  } finally { await capped.close(); }
});

test('GET /api/cities understands regions, other scripts and small towns, with a hint for aliases', async () => {
  const api = env.as('carrier@test.com');
  const find = async (q) => (await api.get(`/api/cities?q=${encodeURIComponent(q)}`)).json.items;
  const x = await find('Xorazm');
  assert.equal(x[0].label, 'Urgench, UZ');
  assert.equal(x[0].note, 'Xorazm');
  assert.equal((await find('Хоразм'))[0].label, 'Urgench, UZ');
  assert.equal((await find('Тошкент'))[0].label, 'Tashkent, UZ');
  assert.ok((await find('Асино')).some((c) => c.label === 'Asino, RU'));
  assert.ok((await find('Elektrogorsk')).some((c) => c.label === 'Elektrogorsk, RU'));
  assert.equal((await find('Tashkent, UZ'))[0].label, 'Tashkent, UZ', 'a full label still works');
  assert.equal((await find('Zzqxkw')).length, 0);
});

test('loads carry exact coordinates (so the map link never depends on a name spelling)', async () => {
  const api = env.as('carrier@test.com');
  const A = await env.cityId('Tomsk, RU'); const B = await env.cityId('Tashkent, UZ');
  const created = (await api.post('/api/loads', validLoad(A, B))).json;
  assert.ok(Math.abs(created.originLat - 56.5) < 0.5 && Math.abs(created.originLng - 84.97) < 0.5, JSON.stringify(created));
  assert.ok(Math.abs(created.destLat - 41.3) < 0.5 && Math.abs(created.destLng - 69.24) < 0.5);
  const listed = (await api.get('/api/loads')).json.items.find((l) => l.id === created.id);
  assert.equal(typeof listed.originLat, 'number');
  assert.equal(typeof listed.destLng, 'number');
  assert.equal((await api.get(`/api/loads/${created.id}`)).json.originLat, created.originLat);
});
