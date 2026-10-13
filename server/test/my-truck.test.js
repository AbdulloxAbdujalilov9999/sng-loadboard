import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

let env; let S; let T;
const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const truck = (over = {}) => ({ locCityId: S, equip: 'T', capacityT: 22, availableFrom: day(1), contactPhone: '+998 71 200 11 22', ...over });

before(async () => {
  env = await startTestEnv();
  S = await env.cityId('Samarkand, UZ'); T = await env.cityId('Tashkent, UZ');
  await env.approvedMember('drv@test.com', 'Driver One');
  await env.approvedMember('other@test.com', 'Other Co');
});
after(async () => { await env.close(); });

test('my truck: save once, it comes back with the profile; replace; clear', async () => {
  const api = env.as('drv@test.com');
  assert.equal((await api.get('/api/me')).json.profile.myTruck, null);
  const put = await api.put('/api/me/truck', { equip: 'R', capacityT: 20, volumeM3: 82, hasTir: true, locCityId: S, plate: ' 01 A 123 BC ', driverName: 'Aziz', driverPhone: '+998 90 111 22 33' });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.profile.myTruck, { equip: 'R', capacityT: 20, volumeM3: 82, hasTir: true, hasAdr: false, hasGps: false, sideLoading: false,
    locCityId: S, locCity: 'Samarkand, UZ', destPref: '', plate: '01 A 123 BC', trailerPlate: '', driverName: 'Aziz', driverPhone: '+998 90 111 22 33', notes: '' });
  assert.equal((await api.get('/api/me')).json.profile.myTruck.equip, 'R');
  assert.equal((await api.put('/api/me/truck', { equip: 'T', capacityT: 24 })).json.profile.myTruck.volumeM3, null, 'a new save replaces the old one');
  assert.equal((await api.del('/api/me/truck')).json.profile.myTruck, null);
});

test('my truck: validation', async () => {
  const api = env.as('drv@test.com');
  for (const bad of [{ capacityT: 20 }, { equip: 'Q', capacityT: 20 }, { equip: 'T', capacityT: 0 }, { equip: 'T', capacityT: 20, locCityId: 424242 },
    { equip: 'T', capacityT: 20, ownerId: 1 }, { equip: 'T', capacityT: 20, driverPhone: '!!' }]) {
    assert.equal((await api.put('/api/me/truck', bad)).status, 400, JSON.stringify(bad));
  }
});

test('edit a posted truck: partial change keeps the rest; strangers cannot', async () => {
  const api = env.as('drv@test.com');
  const t = (await api.post('/api/trucks', truck({ hasTir: true, hasGps: true, notes: 'fast' }))).json;
  const r = await api.patch(`/api/trucks/${t.id}`, { capacityT: 18, locCityId: T, destPref: 'Moscow' });
  assert.equal(r.status, 200);
  assert.equal(r.json.capacityT, 18); assert.equal(r.json.locCity, 'Tashkent, UZ'); assert.equal(r.json.destPref, 'Moscow');
  assert.equal(r.json.hasTir, true, 'flags that were not sent stay'); assert.equal(r.json.hasGps, true); assert.equal(r.json.notes, 'fast');
  assert.equal((await api.patch(`/api/trucks/${t.id}`, { hasTir: false, availableTo: null })).json.hasTir, false);
  assert.equal((await api.patch(`/api/trucks/${t.id}`, { availableTo: day(-5) })).status, 400);
  assert.equal((await api.patch(`/api/trucks/${t.id}`, { contactPhone: '', contactTelegram: '' })).status, 400, 'a way to be reached must remain');
  assert.equal((await env.as('other@test.com').patch(`/api/trucks/${t.id}`, { capacityT: 5 })).status, 403);
  assert.equal((await api.patch('/api/trucks/999999', { capacityT: 5 })).status, 404);
});

test('renew a truck: counts from today again, only for its owner', async () => {
  const api = env.as('drv@test.com');
  const t = (await api.post('/api/trucks', truck({ availableFrom: day(0), availableTo: day(2) }))).json;
  const r = await api.post(`/api/trucks/${t.id}/renew`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json.availableTo, null);
  assert.equal(r.json.availableFrom, day(0));
  assert.equal((await env.as('other@test.com').post(`/api/trucks/${t.id}/renew`, {})).status, 403);
});
