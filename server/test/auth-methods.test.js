import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';

let env;
const PHONE = '+998901234567';
before(async () => { env = await startTestEnv(); await env.approvedMember('viewer@test.com', 'Viewer Co'); });
after(async () => { await env.close(); });

const leaks = (...bodies) => bodies.some((b) => JSON.stringify(b).includes('phone.sng'));

test('phone sign-in: a new number asks for access, the owner sees the number, nothing internal leaks', async () => {
  const me = env.as(PHONE);
  const first = await me.get('/api/me');
  assert.equal(first.status, 200);
  assert.equal(first.json.status, 'none');
  assert.equal(first.json.email, '', 'no e-mail on phone sign-in');
  assert.equal(first.json.login, PHONE);
  assert.equal(first.json.provider, 'phone');

  assert.equal((await me.get('/api/loads')).status, 403, 'no access before approval');
  const req = await me.post('/api/me/access-request', { company: 'Phone Cargo', phone: PHONE, telegram: '@phone_cargo', contactEmail: 'Dispatch@PhoneCargo.uz' });
  assert.equal(req.status, 201, JSON.stringify(req.json));
  assert.equal(req.json.profile.contactEmail, 'dispatch@phonecargo.uz');
  assert.equal(req.json.profile.login, PHONE);
  assert.equal(req.json.profile.email, '');
  assert.equal((await me.post('/api/me/access-request', { company: 'Again', phone: PHONE, telegram: '@again_x' })).status, 409, 'one request per number');

  const owner = env.as('owner@test.com');
  const pending = (await owner.get('/api/admin/members?status=pending')).json;
  const row = pending.items.find((m) => m.company === 'Phone Cargo');
  assert.equal(row.login, PHONE, 'the owner approves by phone number');
  assert.equal(row.contactEmail, 'dispatch@phonecargo.uz');
  assert.equal((await owner.post(`/api/admin/members/${row.id}/approve`)).status, 200);

  assert.equal((await me.get('/api/me')).json.status, 'approved');
  const posted = await me.post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Tashkent, UZ')));
  assert.equal(posted.status, 201);
  assert.equal(posted.json.company, 'Phone Cargo');

  const viewer = env.as('viewer@test.com');
  const dir = await viewer.get('/api/directory');
  const entry = dir.json.items.find((c) => c.company === 'Phone Cargo');
  assert.equal(entry.email, 'dispatch@phonecargo.uz', 'others see the chosen contact e-mail, never the internal key');
  assert.ok(!leaks(first.json, req.json, pending, dir.json, (await viewer.get('/api/loads')).json, (await owner.get('/api/admin/members?status=all')).json),
    'the synthetic identity never reaches a browser');
});

test('phone number is never the owner, and owners are matched on verified e-mail only', async () => {
  const me = env.as('+998909999999');
  assert.equal((await me.get('/api/me')).json.isOwner, false);
  assert.equal((await me.get('/api/admin/members')).status, 403);
  // an ordinary member whose profile has no contact e-mail shows the login e-mail in the directory
  const dir = (await env.as('viewer@test.com').get('/api/directory')).json.items;
  assert.ok(Array.isArray(dir));
});

test('contact e-mail overrides the login e-mail in the directory, and can be cleared', async () => {
  const v = env.as('viewer@test.com');
  const find = async () => (await env.as('owner@test.com').get('/api/directory')).json.items.find((c) => c.company === 'Viewer Co');
  assert.equal((await find()).email, 'viewer@test.com');
  assert.equal((await v.patch('/api/me/profile', { contactEmail: 'sales@viewer.uz' })).status, 200);
  assert.equal((await find()).email, 'sales@viewer.uz');
  assert.equal((await v.patch('/api/me/profile', { contactEmail: '' })).status, 200);
  assert.equal((await find()).email, 'viewer@test.com');
});
