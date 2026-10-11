import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { sweepExpiredLoads } from '../src/lib/expiry.js';

let env; let tash; let almaty;
before(async () => {
  env = await startTestEnv();
  tash = await env.cityId('Tashkent, UZ');
  almaty = await env.cityId('Almaty, KZ');
  await env.approvedMember('exp-dias@test.com', 'KazTrans');
  await env.approvedMember('exp-sardor@test.com', 'Valley Fresh');
});
after(async () => { await env.close(); });

const age = (id, hours) => env.pool.query(`UPDATE loads SET created_at = now() - make_interval(hours => $2::int) WHERE id = $1`, [id, hours]);
const status = async (id) => (await env.pool.query('SELECT status FROM loads WHERE id = $1', [id])).rows[0].status;

test('loads expire 24 hours after they were posted, by default; younger ones stay', async () => {
  const dias = env.as('exp-dias@test.com');
  const me = (await dias.get('/api/me')).json;
  assert.deepEqual(me.loadExpiry, { enabled: true, hours: 24 });

  const old = (await dias.post('/api/loads', validLoad(almaty, tash))).json;
  const young = (await dias.post('/api/loads', validLoad(almaty, tash))).json;
  await age(old.id, 25);
  await age(young.id, 23);
  assert.equal(await sweepExpiredLoads(env.pool), 1);
  assert.equal(await status(old.id), 'closed');
  assert.equal(await status(young.id), 'active');
  const { rows: [r] } = await env.pool.query('SELECT closed_at FROM loads WHERE id = $1', [old.id]);
  assert.ok(r.closed_at, 'closed_at is recorded');
  assert.equal((await dias.get(`/api/loads/${old.id}`)).status, 404, 'an expired load is gone from the board');
  assert.ok(!(await dias.get('/api/loads/mine')).json.items.some((l) => l.id === old.id));
  assert.equal(await sweepExpiredLoads(env.pool), 0, 'nothing left to do');
});

test('the owner changes or switches off the expiry; only the owner can', async () => {
  const owner = env.as('owner@test.com');
  const dias = env.as('exp-dias@test.com');
  assert.equal((await dias.put('/api/admin/load-expiry', { enabled: true, hours: 5 })).status, 403);
  assert.equal((await owner.put('/api/admin/load-expiry', { enabled: true, hours: 0 })).status, 400, 'hours must be at least 1');
  assert.equal((await owner.put('/api/admin/load-expiry', { enabled: true, hours: 9999 })).status, 400);

  const load = (await dias.post('/api/loads', validLoad(almaty, tash))).json;
  await age(load.id, 30);
  assert.equal((await owner.put('/api/admin/load-expiry', { enabled: false, hours: 24 })).status, 200);
  assert.equal(await sweepExpiredLoads(env.pool), 0, 'switched off: nothing expires');
  assert.equal(await status(load.id), 'active');
  assert.deepEqual((await dias.get('/api/me')).json.loadExpiry, { enabled: false, hours: 0 });

  // shorter limit: applied right away
  await age(load.id, 7);
  const on = await owner.put('/api/admin/load-expiry', { enabled: true, hours: 6 });
  assert.equal(on.status, 200);
  assert.ok(on.json.removed >= 1);
  assert.equal(await status(load.id), 'closed');
  assert.equal((await owner.get('/api/admin/load-expiry')).json.hours, 6);
  await owner.put('/api/admin/load-expiry', { enabled: true, hours: 24 });
});

test('renew: the owner of a load starts its 24 hours over; nobody else can', async () => {
  const dias = env.as('exp-dias@test.com');
  const sardor = env.as('exp-sardor@test.com');
  const load = (await dias.post('/api/loads', validLoad(almaty, tash))).json;
  await age(load.id, 20);
  assert.equal((await sardor.post(`/api/loads/${load.id}/renew`)).status, 403);
  const renewed = await dias.post(`/api/loads/${load.id}/renew`);
  assert.equal(renewed.status, 200);
  assert.ok(Date.now() - Date.parse(renewed.json.createdAt) < 60_000, 'counts as posted now');
  assert.equal(await sweepExpiredLoads(env.pool), 0);
  assert.equal((await dias.post('/api/loads/99999999/renew')).status, 404);
  await age(load.id, 25);
  await sweepExpiredLoads(env.pool);
  assert.equal((await dias.post(`/api/loads/${load.id}/renew`)).status, 404, 'too late: it has expired');
});

test('two sweepers at once do not trip over each other', async () => {
  const dias = env.as('exp-dias@test.com');
  const ids = [];
  for (let i = 0; i < 3; i += 1) { const l = (await dias.post('/api/loads', validLoad(almaty, tash))).json; await age(l.id, 48); ids.push(l.id); }
  const counts = await Promise.all([sweepExpiredLoads(env.pool), sweepExpiredLoads(env.pool), sweepExpiredLoads(env.pool)]);
  assert.equal(counts.reduce((a, b) => a + b, 0), 3, 'each load is closed exactly once');
});

test('posts closed long ago are purged; recent ones are kept', async () => {
  const { purgeClosedPosts } = await import('../src/lib/expiry.js');
  const dias = env.as('exp-dias@test.com');
  const a = (await dias.post('/api/loads', validLoad(almaty, tash))).json;
  const b = (await dias.post('/api/loads', validLoad(almaty, tash))).json;
  await env.pool.query(`UPDATE loads SET status = 'closed', closed_at = now() - interval '120 days' WHERE id = $1`, [a.id]);
  await env.pool.query(`UPDATE loads SET status = 'closed', closed_at = now() - interval '5 days' WHERE id = $1`, [b.id]);
  assert.ok(await purgeClosedPosts(env.pool) >= 1);
  const left = (await env.pool.query('SELECT id FROM loads WHERE id = ANY($1)', [[a.id, b.id]])).rows.map((r) => r.id);
  assert.deepEqual(left, [b.id]);
});
