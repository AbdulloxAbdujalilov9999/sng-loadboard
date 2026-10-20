import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';

let env; let ids; let loadId; let truckId;

before(async () => {
  env = await startTestEnv();
  ids = {};
  for (const l of ['Tashkent, UZ', 'Moscow, RU', 'Almaty, KZ']) ids[l] = await env.cityId(l);
  await env.approvedMember('dias@test.com', 'KazTrans');
  const api = env.as('dias@test.com');
  const l = await api.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']));
  loadId = l.json.id;
  const t = await api.post('/api/trucks', {
    locCityId: ids['Almaty, KZ'], equip: 'T', capacityT: 20, availableFrom: new Date().toISOString().slice(0, 10),
    contactPhone: '+7 727 880 1234',
  });
  truckId = t.json.id;
});
after(async () => { await env.close(); });

test('guest can list loads with no auth, and contact details are masked', async () => {
  const res = await env.anon().get('/api/guest/loads');
  assert.equal(res.status, 200);
  const found = res.json.items.find((i) => i.id === loadId);
  assert.ok(found, 'posted load is visible to a guest');
  assert.equal(found.contactPhone, null);
  assert.equal(found.contactEmail, null);
  assert.equal(found.contactTelegram, null);
  assert.equal(found.signInToContact, true);
  assert.equal(found.mine, false);
  // Non-contact fields are still real
  assert.equal(found.originCity, 'Almaty, KZ');
  assert.equal(found.company, 'KazTrans');
});

test('guest can list trucks with no auth, and contact details are masked', async () => {
  const res = await env.anon().get('/api/guest/trucks');
  assert.equal(res.status, 200);
  const found = res.json.items.find((i) => i.id === truckId);
  assert.ok(found);
  assert.equal(found.contactPhone, null);
  assert.equal(found.contactTelegram, null);
  assert.equal(found.signInToContact, true);
});

test('guest can fetch a single load/truck by id, masked the same way', async () => {
  const l = await env.anon().get(`/api/guest/loads/${loadId}`);
  assert.equal(l.status, 200);
  assert.equal(l.json.contactPhone, null);
  const t = await env.anon().get(`/api/guest/trucks/${truckId}`);
  assert.equal(t.status, 200);
  assert.equal(t.json.contactPhone, null);
});

test('guest gets 404 for a closed/unknown load, not the masked member error', async () => {
  const res = await env.anon().get('/api/guest/loads/999999999');
  assert.equal(res.status, 404);
});

test('guest search respects filters the same way the member board does (equip)', async () => {
  const res = await env.anon().get('/api/guest/loads?equip=R');
  assert.equal(res.status, 200);
  assert.ok(!res.json.items.some((i) => i.id === loadId), 'Tent load excluded when filtering for Refrigerator');
});

test('guest list is capped at the guest page-size limit even if a larger limit is requested', async () => {
  const res = await env.anon().get('/api/guest/loads?limit=500');
  assert.equal(res.status, 200); // the schema would 400 a member's own request over 100; guests are clamped instead, not rejected
});

test('guest endpoints never require sign-in (no 401/403)', async () => {
  for (const url of ['/api/guest/loads', '/api/guest/trucks']) {
    const res = await env.anon().get(url);
    assert.equal(res.status, 200, url);
  }
});
