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

test('new user: sign up with a name + one contact -> a member straight away (no approval)', async () => {
  const alice = env.as('alice@gmail.com', 'Alice K');
  let me = await alice.get('/api/me');
  assert.equal(me.json.status, 'none');
  assert.equal(me.json.isOwner, false);

  assert.equal((await alice.get('/api/loads')).status, 403, 'no account yet');
  assert.equal((await alice.get('/api/loads')).json.error.code, 'no_account');

  const bad = await alice.post('/api/me/access-request', { contactName: '', phone: 'x', telegram: '??' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'validation_error');

  const noContact = await alice.post('/api/me/access-request', { contactName: 'Alice K' });
  assert.equal(noContact.status, 400, 'a phone number OR a Telegram username is required');
  assert.deepEqual(noContact.json.error.details.map((d) => d.code), ['contact_required', 'contact_required']);

  const ok = await alice.post('/api/me/access-request', { contactName: 'Alice K', phone: '+998 90 111 22 33', telegram: 'alice_cargo' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.profile.telegram, '@alice_cargo', 'handle normalised with @');
  assert.equal(ok.json.profile.status, 'approved', 'no waiting for approval');
  assert.equal(ok.json.profile.company, 'Alice K', 'no company given: the name stands in');

  me = await alice.get('/api/me');
  assert.equal(me.json.status, 'approved');
  assert.equal((await alice.get('/api/loads')).status, 200, 'can use the platform at once');

  const twice = await alice.post('/api/me/access-request', { contactName: 'Again', phone: '+998 90 111 22 33' });
  assert.equal(twice.status, 409, 'cannot sign up twice');

  // either contact alone is enough; e-mail and company are optional
  const onlyTg = await env.as('tg-only@gmail.com').post('/api/me/access-request', { contactName: 'Tg Only', telegram: '@tg_only' });
  assert.equal(onlyTg.status, 201);
  const onlyPhone = await env.as('phone-only@gmail.com').post('/api/me/access-request', { contactName: 'Phone Only', phone: '+998901234567', company: 'Phone Co' });
  assert.equal(onlyPhone.status, 201);
  assert.equal(onlyPhone.json.profile.company, 'Phone Co');
});

test('the owner sees who joined, and can still block, unblock and remove members', async () => {
  const alice = env.as('alice@gmail.com');
  const owner = env.as('owner@test.com');
  const outsider = env.as('mallory@gmail.com');

  assert.equal((await alice.get('/api/admin/members')).status, 403, 'members cannot list members');
  assert.equal((await outsider.get('/api/admin/members')).status, 403);

  const list = await owner.get('/api/admin/members');
  assert.equal(list.status, 200);
  const joined = list.json.items.find((m) => m.email === 'alice@gmail.com');
  assert.ok(joined, 'new member visible to the owner');
  assert.equal(joined.status, 'approved');
  assert.equal(list.json.counts.pending, 0, 'nobody waits for approval any more');

  assert.equal((await alice.post(`/api/admin/members/${joined.id}/reject`)).status, 403, 'cannot block others / self');

  const blocked = await owner.post(`/api/admin/members/${joined.id}/reject`);
  assert.equal(blocked.status, 200);
  assert.equal((await alice.get('/api/loads')).status, 403);
  assert.equal((await alice.get('/api/loads')).json.error.code, 'not_approved_rejected');

  const back = await owner.post(`/api/admin/members/${joined.id}/approve`);
  assert.equal(back.json.profile.status, 'approved');
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

test('everyone is an individual until they say they work with a company', async () => {
  const api = env.as('indiv@gmail.com');
  const created = (await api.post('/api/me/access-request', { contactName: 'Anvar T', telegram: '@anvar_t' })).json.profile;
  assert.equal(created.worksWithCompany, false);
  assert.equal(created.company, 'Anvar T', 'an individual is shown by name');

  const { validLoad } = await import('./helpers.js');
  const post = await api.post('/api/loads', validLoad(await env.cityId('Tashkent, UZ'), await env.cityId('Moscow, RU')));
  assert.equal(post.json.company, 'Anvar T');

  assert.equal((await api.patch('/api/me/profile', { worksWithCompany: true })).status, 400, 'a company name is required');
  const on = await api.patch('/api/me/profile', { worksWithCompany: true, company: 'Silk Road Trans', fleet: '12 trucks' });
  assert.equal(on.json.profile.company, 'Silk Road Trans');
  assert.equal(on.json.profile.worksWithCompany, true);
  assert.equal((await api.get('/api/loads/mine')).json.items[0].company, 'Silk Road Trans', 'live posts follow');
  assert.equal((await api.patch('/api/me/profile', { contactName: 'Anvar Tolipov' })).json.profile.company, 'Silk Road Trans', 'a company keeps its name when the person is renamed');

  const off = await api.patch('/api/me/profile', { worksWithCompany: false });
  assert.equal(off.json.profile.company, 'Anvar Tolipov', 'back to an individual: the name is shown again');
  assert.equal((await api.patch('/api/me/profile', { contactName: 'Anvar T.' })).json.profile.company, 'Anvar T.', 'an individual\'s shown name follows their name');
  assert.equal((await api.get('/api/loads/mine')).json.items[0].company, 'Anvar T.');
  // naming a company on its own switches it on (older clients)
  assert.equal((await api.patch('/api/me/profile', { company: 'Anvar Cargo' })).json.profile.worksWithCompany, true);
});

test('subscriptions: off by default; free trial, then the whole board closes until the owner adds paid time', async () => {
  const owner = env.as('owner@test.com');
  const sam = env.as('sub-sam@gmail.com');
  await sam.post('/api/me/access-request', { contactName: 'Sam Driver', telegram: '@sam_driver' });
  assert.equal((await sam.get('/api/me')).json.subscription.state, 'off', 'nobody pays while it is switched off');
  assert.equal((await sam.get('/api/loads')).status, 200);

  assert.equal((await sam.put('/api/admin/subscription', { enabled: true, trialDays: 14, priceText: 'x', payText: 'y' })).status, 403, 'owner only');
  const on = await owner.put('/api/admin/subscription', { enabled: true, trialDays: 14, priceText: '100 000 UZS / month', payText: 'Humo 8600 ...\nSend the receipt to @owner' });
  assert.equal(on.status, 200);
  assert.ok(on.json.enabledAt);

  // members who joined before it was switched on get their trial from now
  let me = (await sam.get('/api/me')).json.subscription;
  assert.equal(me.state, 'trial');
  assert.ok(me.daysLeft >= 13 && me.daysLeft <= 14);
  assert.equal(me.priceText, '100 000 UZS / month');
  assert.match(me.payText, /Humo/);
  assert.equal((await sam.get('/api/loads')).status, 200, 'trial: everything works');

  // a new member's trial starts at sign-up
  const nia = env.as('sub-nia@gmail.com');
  await nia.post('/api/me/access-request', { contactName: 'Nia', telegram: '@nia_x' });
  assert.equal((await nia.get('/api/me')).json.subscription.state, 'trial');

  // the trial ends
  await env.pool.query("UPDATE members SET trial_ends_at = now() - interval '1 hour' WHERE email = 'sub-sam@gmail.com'");
  me = (await sam.get('/api/me')).json;
  assert.equal(me.subscription.state, 'expired');
  for (const url of ['/api/loads', '/api/trucks', '/api/directory', '/api/stats', '/api/cities?q=tash']) {
    const r = await sam.get(url);
    assert.equal(r.status, 402, url);
    assert.equal(r.json.error.code, 'subscription_required');
  }
  assert.equal((await sam.post('/api/loads', {})).status, 402, 'posting is closed too');
  assert.equal((await sam.post('/api/ai/parse-loads', { text: 'x' })).status, 402, 'AI paste too');
  assert.equal((await sam.patch('/api/me/profile', { location: 'Tashkent' })).status, 200, 'the profile still works');
  assert.equal((await owner.get('/api/loads')).status, 200, 'the owner is never locked out');

  // the owner adds paid time after the member pays
  const { rows: [m] } = await env.pool.query("SELECT id FROM members WHERE email = 'sub-sam@gmail.com'");
  assert.equal((await sam.post(`/api/admin/members/${m.id}/subscription`, { days: 30 })).status, 403);
  const paid = await owner.post(`/api/admin/members/${m.id}/subscription`, { days: 30 });
  assert.equal(paid.json.subscription.state, 'paid');
  assert.ok(paid.json.subscription.daysLeft >= 29);
  assert.equal((await sam.get('/api/loads')).status, 200, 'unlocked');
  const more = await owner.post(`/api/admin/members/${m.id}/subscription`, { days: 90 });
  assert.ok(more.json.subscription.daysLeft >= 119, 'paid time adds up');

  const list = (await owner.get('/api/admin/members')).json;
  assert.equal(list.subscriptionEnabled, true);
  assert.equal(list.items.find((x) => x.id === m.id).subscription.state, 'paid');

  // end access, and switch the whole thing off again
  assert.equal((await owner.del(`/api/admin/members/${m.id}/subscription`)).json.subscription.state, 'expired');
  assert.equal((await sam.get('/api/loads')).status, 402);
  await owner.put('/api/admin/subscription', { enabled: false, trialDays: 14, priceText: '', payText: '' });
  assert.equal((await sam.get('/api/loads')).status, 200, 'switched off: everyone is back in');
  assert.equal((await sam.get('/api/me')).json.subscription.state, 'off');
});
