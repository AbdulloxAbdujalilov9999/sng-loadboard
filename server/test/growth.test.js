import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { clickLink, paymeLink, publicExtras } from '../src/lib/growth.js';

let env; let ids;

before(async () => {
  env = await startTestEnv();
  ids = {};
  for (const l of ['Tashkent, UZ', 'Moscow, RU', 'Almaty, KZ']) ids[l] = await env.cityId(l);
  await env.approvedMember('inviter@test.com', 'Inviter Co');
  await env.approvedMember('booster@test.com', 'Booster Co');
  await env.approvedMember('other@test.com', 'Other Co');
});
after(async () => { await env.close(); });

const ownerApi = () => env.as('owner@test.com');
const memberId = async (email) => (await env.pool.query('SELECT id FROM members WHERE email = $1', [email])).rows[0].id;

test('every member gets an invite code; a friend who signs up with it and posts a first load earns the inviter a TOP credit, once', async () => {
  const me = await env.as('inviter@test.com').get('/api/me');
  assert.equal(me.status, 200);
  const code = me.json.growth.refCode;
  assert.match(code, /^[a-f0-9]{8}$/);
  assert.equal(me.json.growth.boostCredits, 0);

  const reg = await env.anon().post('/api/auth/phone/register', { phone: '+998901112233', pin: '4321', contactName: 'Friend', ref: code.toUpperCase() });
  assert.equal(reg.status, 201);
  const friend = env.withToken(reg.json.token);
  assert.equal((await env.as('inviter@test.com').get('/api/me')).json.growth.invited, 1);
  assert.equal((await env.as('inviter@test.com').get('/api/me')).json.growth.boostCredits, 0, 'signing up alone earns nothing');

  assert.equal((await friend.post('/api/loads', validLoad(ids['Tashkent, UZ'], ids['Moscow, RU']))).status, 201);
  assert.equal((await friend.post('/api/loads', validLoad(ids['Moscow, RU'], ids['Tashkent, UZ']))).status, 201);
  const after1 = (await env.as('inviter@test.com').get('/api/me')).json.growth;
  assert.equal(after1.boostCredits, 1, 'only the first load counts');
  assert.equal(after1.invitedActive, 1);
});

test('a wrong or garbage invite code never blocks a sign-up', async () => {
  const a = await env.anon().post('/api/auth/phone/register', { phone: '+998901112244', pin: '4321', contactName: 'A', ref: 'zzzzzzzz' });
  assert.equal(a.status, 201);
  const b = await env.anon().post('/api/auth/phone/register', { phone: '+998901112255', pin: '4321', contactName: 'B', ref: '<script>' });
  assert.equal(b.status, 201);
});

test('repost is free but limited by the cooldown; the owner of the load only', async () => {
  const api = env.as('booster@test.com');
  const load = (await api.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']))).json;
  const early = await api.post(`/api/loads/${load.id}/repost`);
  assert.equal(early.status, 429, 'just posted = just broadcast');
  assert.equal(early.json.error.code, 'repost_wait');

  await env.pool.query("UPDATE loads SET broadcast_at = now() - interval '7 hours' WHERE id = $1", [load.id]);
  assert.equal((await env.as('other@test.com').post(`/api/loads/${load.id}/repost`)).status, 403);
  const ok = await api.post(`/api/loads/${load.id}/repost`);
  assert.equal(ok.status, 200);
  assert.ok(ok.json.nextRepostAt);
  assert.equal((await api.post(`/api/loads/${load.id}/repost`)).status, 429);
});

test('TOP spends a credit, puts the load in /api/loads/top for matching searches only, and refuses with no credits', async () => {
  const api = env.as('booster@test.com');
  const load = (await api.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Moscow, RU']))).json;
  const none = await api.post(`/api/loads/${load.id}/boost`);
  assert.equal(none.status, 402);
  assert.equal(none.json.error.code, 'no_credits');

  const add = await ownerApi().post(`/api/admin/members/${await memberId('booster@test.com')}/credits`, { credits: 2 });
  assert.equal(add.status, 200);
  assert.equal(add.json.profile.boostCredits, 2);

  const top = await api.post(`/api/loads/${load.id}/boost`);
  assert.equal(top.status, 200);
  assert.equal(top.json.top, true);
  assert.equal(top.json.boostCredits, 1);

  const list = await env.as('other@test.com').get(`/api/loads/top?origin=${ids['Almaty, KZ']}`);
  assert.deepEqual(list.json.items.map((l) => l.id), [load.id]);
  assert.equal(list.json.items[0].top, true);
  const elsewhere = await env.as('other@test.com').get(`/api/loads/top?origin=${ids['Moscow, RU']}&originRadius=50`);
  assert.equal(elsewhere.json.items.length, 0);
  const guest = await env.anon().get('/api/guest/loads/top');
  assert.equal(guest.json.items[0].id, load.id);
  assert.equal(guest.json.items[0].contactPhone, null);

  assert.equal((await env.as('other@test.com').post(`/api/loads/${load.id}/boost`)).status, 403);
  // credits never go below zero, even when the owner takes back more than is left
  const take = await ownerApi().post(`/api/admin/members/${await memberId('booster@test.com')}/credits`, { credits: -5 });
  assert.equal(take.json.profile.boostCredits, 0);
});

test('verified badge: set by the owner, shown on the member and their loads (existing and new)', async () => {
  const api = env.as('other@test.com');
  const before1 = (await api.post('/api/loads', validLoad(ids['Tashkent, UZ'], ids['Almaty, KZ']))).json;
  assert.equal(before1.verified, false);
  assert.equal((await api.put(`/api/admin/members/${await memberId('other@test.com')}/verified`, { verified: true })).status, 403);
  const v = await ownerApi().put(`/api/admin/members/${await memberId('other@test.com')}/verified`, { verified: true });
  assert.equal(v.json.profile.verified, true);
  assert.equal((await api.get(`/api/loads/${before1.id}`)).json.verified, true);
  const fresh = (await api.post('/api/loads', validLoad(ids['Almaty, KZ'], ids['Tashkent, UZ']))).json;
  assert.equal(fresh.verified, true);
  assert.equal((await api.get('/api/me')).json.growth.verified, true);
  await ownerApi().put(`/api/admin/members/${await memberId('other@test.com')}/verified`, { verified: false });
  assert.equal((await api.get(`/api/loads/${fresh.id}`)).json.verified, false);
});

test('extras: hidden until switched on, then prices and pay links that carry the member id', async () => {
  const api = env.as('inviter@test.com');
  assert.deepEqual((await api.get('/api/me')).json.extras, { enabled: false });
  const put = await ownerApi().put('/api/admin/extras', {
    enabled: true, boostPriceUzs: 15000, boostPack: 3, verifyPriceUzs: 50000, payText: 'Write to @sng_admin',
    paymeMerchantId: 'abc123', clickServiceId: '111', clickMerchantId: '222',
  });
  assert.equal(put.status, 200);
  const ex = (await api.get('/api/me')).json.extras;
  const id = await memberId('inviter@test.com');
  assert.equal(ex.enabled, true);
  assert.equal(ex.boostPack, 3);
  assert.equal(ex.boost.order, `top-${id}`);
  assert.equal(Buffer.from(ex.boost.payme.split('/').pop(), 'base64').toString(), `m=abc123;ac.order_id=top-${id};a=1500000`);
  assert.match(ex.verify.click, /service_id=111&merchant_id=222&amount=50000&transaction_param=verify-/);
  assert.equal((await api.put('/api/admin/extras', { enabled: false, boostPriceUzs: 0, verifyPriceUzs: 0 })).status, 403);
});

test('pay links are left out when merchant ids or a price are missing', () => {
  assert.equal(paymeLink({ paymeMerchantId: '' }, { amountUzs: 1000, order: 'x' }), null);
  assert.equal(clickLink({ clickServiceId: '1', clickMerchantId: '' }, { amountUzs: 1000, order: 'x' }), null);
  const ex = publicExtras({ enabled: true, boostPriceUzs: 0, verifyPriceUzs: 1000, paymeMerchantId: 'm', paymeAccountField: 'order_id' }, 7);
  assert.equal(ex.boost, null);
  assert.ok(ex.verify.payme);
  assert.equal(ex.verify.click, null);
});
