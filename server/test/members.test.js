import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from './helpers.js';

let env;
before(async () => { env = await startTestEnv(); });
after(async () => { await env.close(); });

test('migrations are idempotent and seed reference data', async () => {
  const { runMigrations } = await import('../src/migrate.js');
  const again = await runMigrations(env.pool, { log() {}, info() {} });
  assert.deepEqual(again, [], 'second run applies nothing');
  const { rows: [c] } = await env.pool.query('SELECT count(*)::int AS n FROM cities');
  assert.ok(c.n >= 150, `expected >=150 cities, got ${c.n}`);
  const { rows: [f] } = await env.pool.query("SELECT count(*)::int AS n FROM fx_rates WHERE code = 'USD'");
  assert.equal(f.n, 1);
});

test('database constraints reject bad rows even if the API were bypassed', async () => {
  const m = await env.approvedMember('constraint@test.com');
  const t = await env.cityId('Tashkent, UZ');
  const bad = (sql, params) => assert.rejects(env.pool.query(sql, params), /violates (check|foreign key)/);
  const insert = `INSERT INTO loads (owner_id, origin_city_id, origin_city, origin_lat, origin_lng, dest_city_id, dest_city, dest_lat, dest_lng,
     equip, fp, weight_t, pickup_date, distance_km, rate_usd, commodity, company_name, contact_name, contact_phone, contact_email, contact_tg)
     VALUES ($1,$2,'a',1,1,$3,'b',1,1,$4,'Full',$5,current_date,$6,100,'x','c','n','p','e','t')`;
  const base = [m.id, t, t + 1, 'T', 10, 500];
  await bad(insert, [m.id, t, t, 'T', 10, 500]);              // same origin & destination
  await bad(insert, [m.id, t, t + 1, 'ZZ', 10, 500]);          // unknown equipment
  await bad(insert, [m.id, t, t + 1, 'T', -1, 500]);           // negative weight
  await bad(insert, [m.id, t, t + 1, 'T', 10, 0]);             // zero distance
  await bad(insert, [999999, t, t + 1, 'T', 10, 500]);         // unknown owner
  await env.pool.query(insert, base);                           // sanity: the valid row goes in
});

test('API requires a valid Google token', async () => {
  const anon = await env.app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(anon.statusCode, 401);
  const junk = await env.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Bearer not-a-real-token' } });
  assert.equal(junk.statusCode, 401);
  const wrongScheme = await env.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: 'Basic abc' } });
  assert.equal(wrongScheme.statusCode, 401);
});

test('public endpoints work without a token', async () => {
  const health = await env.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  const cfg = await env.app.inject({ method: 'GET', url: '/api/config' });
  const j = cfg.json();
  assert.equal(j.currencies.USD.rate, 1);
  assert.ok(j.currencies.RUB.rate > 1);
});

test('owner (from OWNER_EMAILS) is auto-provisioned and recognised', async () => {
  const me = await env.as('owner@test.com').get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.isOwner, true);
  assert.equal(me.json.status, 'approved');
});

test('new user: status none -> request access -> pending, and cannot use the platform', async () => {
  const alice = env.as('alice@gmail.com', 'Alice K');
  let me = await alice.get('/api/me');
  assert.equal(me.json.status, 'none');
  assert.equal(me.json.isOwner, false);

  assert.equal((await alice.get('/api/loads')).status, 403, 'no account yet');

  const bad = await alice.post('/api/me/access-request', { company: '', phone: 'x', telegram: '??' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'validation_error');

  const ok = await alice.post('/api/me/access-request', { company: 'Alice Cargo', phone: '+998 90 111 22 33', telegram: 'alice_cargo' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.profile.telegram, '@alice_cargo', 'handle normalised with @');
  assert.equal(ok.json.profile.status, 'pending');

  me = await alice.get('/api/me');
  assert.equal(me.json.status, 'pending');
  assert.equal((await alice.get('/api/loads')).status, 403);
  assert.equal((await alice.get('/api/loads')).json.error.code, 'not_approved_pending');

  const twice = await alice.post('/api/me/access-request', { company: 'Again', phone: '+998 90 111 22 33', telegram: '@alice_cargo' });
  assert.equal(twice.status, 409, 'cannot request twice');
});

test('only the owner can see and decide requests; approval unlocks the platform', async () => {
  const alice = env.as('alice@gmail.com');
  const owner = env.as('owner@test.com');
  const outsider = env.as('mallory@gmail.com');

  assert.equal((await alice.get('/api/admin/members')).status, 403, 'members cannot list requests');
  assert.equal((await outsider.get('/api/admin/members')).status, 403);

  const list = await owner.get('/api/admin/members?status=pending');
  assert.equal(list.status, 200);
  const req = list.json.items.find((m) => m.email === 'alice@gmail.com');
  assert.ok(req, 'request visible to owner');
  assert.ok(list.json.counts.pending >= 1);

  assert.equal((await alice.post(`/api/admin/members/${req.id}/approve`)).status, 403, 'cannot self-approve');

  const approved = await owner.post(`/api/admin/members/${req.id}/approve`);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.profile.status, 'approved');

  assert.equal((await alice.get('/api/me')).json.status, 'approved');
  assert.equal((await alice.get('/api/loads')).status, 200);
});

test('declining or removing a member revokes access and takes their posts off the board', async () => {
  const bob = await env.approvedMember('bob@gmail.com', 'Bob Freight');
  const t = await env.cityId('Tashkent, UZ');
  const m = await env.cityId('Moscow, RU');
  const { validLoad } = await import('./helpers.js');
  const bobApi = env.as('bob@gmail.com');
  const posted = await bobApi.post('/api/loads', validLoad(t, m));
  assert.equal(posted.status, 201);

  const owner = env.as('owner@test.com');
  const rej = await owner.post(`/api/admin/members/${bob.id}/reject`);
  assert.equal(rej.status, 200);
  assert.equal((await bobApi.get('/api/loads')).status, 403, 'access revoked immediately');
  const { rows: [l] } = await env.pool.query('SELECT status FROM loads WHERE id = $1', [posted.json.id]);
  assert.equal(l.status, 'closed', 'their live loads were closed');

  const del = await owner.del(`/api/admin/members/${bob.id}`);
  assert.equal(del.status, 204);
  assert.equal((await bobApi.get('/api/me')).json.status, 'none', 'record gone: they may request again');
  assert.equal((await owner.del(`/api/admin/members/${bob.id}`)).status, 404);
});

test('owner cannot be decided on by the admin endpoints (no accidental self-lockout)', async () => {
  const owner = env.as('owner@test.com');
  const { rows: [o] } = await env.pool.query("SELECT id FROM members WHERE email = 'owner@test.com'");
  assert.equal((await owner.post(`/api/admin/members/${o.id}/reject`)).status, 404);
  assert.equal((await owner.del(`/api/admin/members/${o.id}`)).status, 404);
});

test('profile edits persist and the company name follows onto live posts', async () => {
  const carol = await env.approvedMember('carol@gmail.com', 'Carol Trans');
  const api = env.as('carol@gmail.com');
  const { validLoad } = await import('./helpers.js');
  const posted = await api.post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Tashkent, UZ')));
  assert.equal(posted.json.company, 'Carol Trans');

  const upd = await api.patch('/api/me/profile', { company: 'Carol Trans International', location: 'Almaty, KZ', tirCarnet: 'TIR-KZ 123' });
  assert.equal(upd.status, 200);
  assert.equal(upd.json.profile.company, 'Carol Trans International');
  const mine = await api.get('/api/loads/mine');
  assert.equal(mine.json.items[0].company, 'Carol Trans International');

  // Fields a member must never be able to set on themselves.
  const evil = await api.patch('/api/me/profile', { status: 'approved', role: 'owner' });
  assert.equal(evil.status, 400, 'unknown fields rejected (no mass assignment)');
  const me = await api.get('/api/me');
  assert.equal(me.json.isOwner, false);
  void carol;
});

test('removing an email from OWNER_EMAILS demotes it on next request', async () => {
  await env.pool.query("UPDATE members SET role = 'owner', status = 'approved' WHERE email = 'carol@gmail.com'");
  const me = await env.as('carol@gmail.com').get('/api/me');
  assert.equal(me.json.isOwner, false);
});

test('FX rates can be updated by the owner only', async () => {
  const body = { rates: { RUB: 100, KZT: 500 } };
  assert.equal((await env.as('alice@gmail.com').put('/api/admin/fx', body)).status, 403);
  const res = await env.as('owner@test.com').put('/api/admin/fx', body);
  assert.equal(res.status, 200);
  assert.equal(res.json.updated, 2);
  const cfg = (await env.app.inject({ method: 'GET', url: '/api/config' })).json();
  assert.equal(cfg.currencies.RUB.rate, 100);
  const badBody = await env.as('owner@test.com').put('/api/admin/fx', { rates: { usd: -3 } });
  assert.equal(badBody.status, 400);
});
