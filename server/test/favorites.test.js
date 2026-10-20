import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';

let env; let ids; let loadId; let truckId;

before(async () => {
  env = await startTestEnv();
  ids = {};
  for (const l of ['Tashkent, UZ', 'Moscow, RU', 'Almaty, KZ']) ids[l] = await env.cityId(l);
  await env.approvedMember('dias@test.com', 'KazTrans');
  await env.approvedMember('sardor@test.com', 'Valley Fresh');
  const owner = env.as('dias@test.com');
  const l = await owner.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']));
  loadId = l.json.id;
  const t = await owner.post('/api/trucks', {
    locCityId: ids['Almaty, KZ'], equip: 'T', capacityT: 20, availableFrom: new Date().toISOString().slice(0, 10),
    contactPhone: '+7 727 880 1234',
  });
  truckId = t.json.id;
});
after(async () => { await env.close(); });

test('save a load, see it in /api/me/favorites, un-save it', async () => {
  const api = env.as('sardor@test.com');
  const save = await api.post('/api/me/favorites', { entityType: 'load', entityId: loadId });
  assert.equal(save.status, 201);
  assert.equal(save.json.entityType, 'load');

  const list = await api.get('/api/me/favorites');
  assert.equal(list.status, 200);
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.items[0].load.id, loadId);
  assert.equal(list.json.items[0].load.company, 'KazTrans');

  const del = await api.del(`/api/me/favorites/load/${loadId}`);
  assert.equal(del.status, 200);
  const after2 = await api.get('/api/me/favorites');
  assert.equal(after2.json.items.length, 0);
});

test('save a truck too - loads and trucks coexist in the same list', async () => {
  const api = env.as('sardor@test.com');
  await api.post('/api/me/favorites', { entityType: 'load', entityId: loadId });
  await api.post('/api/me/favorites', { entityType: 'truck', entityId: truckId });
  const list = await api.get('/api/me/favorites');
  assert.equal(list.json.items.length, 2);
  assert.ok(list.json.items.some((i) => i.entityType === 'truck' && i.truck.id === truckId));
});

test('saving the same post twice does not duplicate it', async () => {
  const api = env.as('sardor@test.com');
  await api.post('/api/me/favorites', { entityType: 'load', entityId: loadId });
  await api.post('/api/me/favorites', { entityType: 'load', entityId: loadId });
  const list = await api.get('/api/me/favorites');
  assert.equal(list.json.items.filter((i) => i.entityType === 'load' && i.load.id === loadId).length, 1);
});

test('cannot favorite a load/truck that does not exist', async () => {
  const api = env.as('sardor@test.com');
  const res = await api.post('/api/me/favorites', { entityType: 'load', entityId: 999999999 });
  assert.equal(res.status, 404);
});

test('un-saving something never saved is a 404, not a 204', async () => {
  const owner = env.as('dias@test.com');
  const fresh = await owner.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']));
  const api = env.as('sardor@test.com');
  const res = await api.del(`/api/me/favorites/load/${fresh.json.id}`);
  assert.equal(res.status, 404);
});

test('favorites require sign-in', async () => {
  const res = await env.anon().get('/api/me/favorites');
  assert.equal(res.status, 401);
});

test('a closed load drops out of favorites without erroring', async () => {
  const owner = env.as('dias@test.com');
  const l = await owner.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']));
  const api = env.as('sardor@test.com');
  await api.post('/api/me/favorites', { entityType: 'load', entityId: l.json.id });
  await owner.del(`/api/loads/${l.json.id}`);
  const list = await api.get('/api/me/favorites');
  assert.ok(!list.json.items.some((i) => i.entityType === 'load' && i.load?.id === l.json.id));
});
