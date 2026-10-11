import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { startTestEnv, validLoad } from './helpers.js';

let env;
const PHONE = '+998901112233';
before(async () => { env = await startTestEnv(); await env.approvedMember('viewer@test.com'); });
after(async () => { await env.close(); });

const login = (phone, pin, purpose) => env.anon().post('/api/auth/pin/login', { phone, pin, ...(purpose ? { purpose } : {}) });

const register = (phone, pin, over = {}) => env.anon().post('/api/auth/phone/register', { phone, pin, contactName: 'Test Person', ...over });

test('phone sign-up needs no SMS: a number + a 4-6 digit password creates the account and signs in', async () => {
  assert.deepEqual((await env.anon().post('/api/auth/phone/check', { phone: PHONE })).json, { exists: false, hasPin: false });
  const r = await register(PHONE, '4729', { contactName: 'Aziz', company: 'Aziz Cargo' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.ok(r.json.token && r.json.expiresAt);
  assert.equal(r.json.profile.status, 'approved', 'a member straight away');
  assert.equal(r.json.profile.phone, PHONE, 'the number is also the contact');
  assert.equal(r.json.profile.company, 'Aziz Cargo');
  assert.deepEqual((await env.anon().post('/api/auth/phone/check', { phone: PHONE })).json, { exists: true, hasPin: true });

  const ok = await login(PHONE, '4729');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const me = await env.withToken(ok.json.token).get('/api/me');
  assert.equal(me.json.provider, 'pin');
  assert.equal(me.json.login, PHONE);
  assert.equal(me.json.profile.loginPhone, PHONE);
  assert.ok(!JSON.stringify(me.json).includes('scrypt'), 'the hash never leaves the server');
  const posted = await env.withToken(ok.json.token).post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Tashkent, UZ')));
  assert.equal(posted.status, 201);
  assert.match((await env.pool.query('SELECT pin_hash FROM members WHERE login_phone = $1', [PHONE])).rows[0].pin_hash, /^scrypt1\$/);

  // the same number cannot be registered twice; passwords are 4-6 digits, and ANY such password is allowed (1111, 1234 ...)
  assert.equal((await register(PHONE, '5821')).json.error.details[0].code, 'phone_taken');
  for (const pin of ['123', '1234567', 'abcd', '12 4']) assert.equal((await register('+998901119999', pin)).status, 400, pin);
  assert.equal((await register('+998901119996', '1111')).status, 201, 'easy passwords are allowed');
  assert.equal((await login('+998901119996', '1111')).status, 200);
  assert.equal((await register('+998901119995', '1234')).status, 201);
  assert.equal((await register('+998901119994', '1212')).status, 201);
  assert.equal((await register('+998901119999', '482915')).status, 201, '6 digits are fine');
  assert.equal((await register('+998901119998', '48291')).status, 201, '5 digits are fine');
  assert.equal((await register('+998901119997', '4829', { contactName: '' })).status, 400, 'a name is required');
  assert.equal((await register('12345', '4829')).status, 400, 'a real phone number is required');
});

test('wrong password: same answer as an unknown number; 5 wrong tries lock it for 15 minutes; the owner can reset it', async () => {
  const phone = '+998905550000';
  await register(phone, '739155');
  const unknown = await login('+998900000001', '739155');
  const wrong = await login(phone, '135799');
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.json.error.message, wrong.json.error.message, 'nobody can probe which numbers exist');

  for (let i = 0; i < 4; i += 1) assert.equal((await login(phone, '135799')).status, 401);
  const locked = await login(phone, '739155'); // even the RIGHT password is refused while locked
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'pin_locked');

  // forgot it: there is no SMS, so the owner issues a new one (shown once) and passes it on
  const owner = env.as('owner@test.com');
  const { rows: [m] } = await env.pool.query('SELECT id FROM members WHERE login_phone = $1', [phone]);
  assert.equal((await env.as('viewer@test.com').post(`/api/admin/members/${m.id}/reset-pin`)).status, 403, 'only the owner');
  const reset = await owner.post(`/api/admin/members/${m.id}/reset-pin`);
  assert.equal(reset.status, 200);
  assert.match(reset.json.pin, /^\d{6}$/);
  assert.equal(reset.json.phone, phone);
  assert.equal((await login(phone, '739155')).status, 401, 'the old password no longer works');
  assert.equal((await login(phone, reset.json.pin)).status, 200, 'the new one does, and the lock is gone');
  assert.equal((await owner.post('/api/admin/members/999999/reset-pin')).status, 404);
});

test('changing the password ends other sessions; the device that changed it stays signed in', async () => {
  const phone = '+998906660000';
  await register(phone, '582137');
  const a = (await login(phone, '582137')).json.token;
  const b = (await login(phone, '582137', 'bot')).json.token; // e.g. the Telegram bot
  assert.equal((await env.withToken(a).get('/api/me')).status, 200);

  assert.equal((await env.withToken(a).put('/api/me/pin', { pin: '603248' })).status, 400, 'needs the current password');
  assert.equal((await env.withToken(a).put('/api/me/pin', { pin: '603248', currentPin: '000000' })).status, 400, 'wrong current password');
  await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole-second issue times
  const changed = await env.withToken(a).put('/api/me/pin', { pin: '603248', currentPin: '582137' });
  assert.equal(changed.status, 200);
  assert.ok(changed.json.token, 'the changing device gets a fresh session');
  assert.equal((await env.withToken(a).get('/api/me')).status, 401, 'the old session ended');
  assert.equal((await env.withToken(b).get('/api/me')).status, 401, 'so did the bot link');
  assert.equal((await env.withToken(changed.json.token).get('/api/me')).status, 200);
});

test('one account, two ways in: a Google member adds a phone + password and can then sign in with either', async () => {
  await env.approvedMember('both@test.com', 'Both Ways Co');
  const google = env.as('both@test.com');
  const phone = '+998907771111';
  assert.equal((await google.post('/api/me/login-phone', { phone: 'abc', pin: '482915' })).status, 400);
  const added = await google.post('/api/me/login-phone', { phone, pin: '482915' });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json.profile.loginPhone, phone);
  assert.equal((await env.anon().post('/api/auth/phone/check', { phone })).json.exists, true);

  const viaPhone = await login(phone, '482915');
  assert.equal(viaPhone.status, 200);
  const me = await env.withToken(viaPhone.json.token).get('/api/me');
  assert.equal(me.json.profile.company, 'Both Ways Co', 'the SAME account, not a new one');
  assert.equal(me.json.login, 'both@test.com');
  // posts made either way belong to the same member
  const A = await env.cityId('Almaty, KZ'); const T = await env.cityId('Tashkent, UZ');
  await env.withToken(viaPhone.json.token).post('/api/loads', validLoad(A, T));
  assert.equal((await google.get('/api/loads/mine')).json.items.length, 1);

  // the number is taken; the owner cannot use a password; changing it from the Google session needs no current password
  await env.approvedMember('other@test.com', 'Other Co');
  assert.equal((await env.as('other@test.com').post('/api/me/login-phone', { phone, pin: '729183' })).json.error.details[0].code, 'phone_taken');
  assert.equal((await env.as('owner@test.com').post('/api/me/login-phone', { phone: '+998908880000', pin: '729183' })).status, 403);
  assert.equal((await google.put('/api/me/pin', { pin: '729183' })).status, 200);
  assert.equal((await login(phone, '482915')).status, 401);
  assert.equal((await login(phone, '729183')).status, 200);

  // removing phone sign-in ends it (and any session that used it)
  const session = (await login(phone, '729183')).json.token;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await google.del('/api/me/login-phone')).status, 200);
  assert.equal((await login(phone, '729183')).status, 401);
  assert.equal((await env.withToken(session).get('/api/me')).status, 401);
  assert.equal((await google.get('/api/me')).json.status, 'approved', 'Google sign-in is untouched');
});

test('PIN rules: owner never signs in with a password; Google accounts without a phone cannot set one', async () => {
  await env.approvedMember('g@test.com');
  assert.equal((await env.as('g@test.com').put('/api/me/pin', { pin: '482915' })).status, 403, 'no sign-in phone yet');
  assert.equal((await login('+998900000009', '482915')).status, 401);
  assert.equal((await env.pool.query("SELECT 1 FROM members WHERE role = 'owner' AND (pin_hash IS NOT NULL OR login_phone IS NOT NULL)")).rowCount, 0);
});

test('session tokens: forged, wrong-secret and expired tokens are refused; refresh issues a new one', async () => {
  const phone = '+998908880000';
  await register(phone, '394715');
  const good = (await login(phone, '394715')).json.token;

  const forge = (secret, alg = 'HS256', expiresIn = '1h') => new SignJWT({ ph: phone, pr: 'web' }).setProtectedHeader({ alg })
    .setSubject('p998908880000@phone.sng').setIssuer('sng-one').setAudience('sng-one-pin').setIssuedAt().setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
  assert.equal((await env.withToken(await forge('attacker-secret-attacker-secret')).get('/api/me')).status, 401, 'signed with another secret');
  assert.equal((await env.withToken(`${good.slice(0, -4)}AAAA`).get('/api/me')).status, 401, 'tampered signature');
  assert.equal((await env.withToken(good.split('.').slice(0, 2).join('.') + '.').get('/api/me')).status, 401, 'no signature');

  const fresh = await env.withToken(good).post('/api/auth/refresh');
  assert.equal(fresh.status, 200);
  assert.equal((await env.withToken(fresh.json.token).get('/api/me')).status, 200);
  assert.equal((await env.as(phone).post('/api/auth/refresh')).status, 404, 'only password sessions refresh this way');
});

test('contact rules: a phone OR a Telegram username is required on posts; e-mail is optional', async () => {
  await env.approvedMember('poster@test.com', 'Poster Co');
  const api = env.as('poster@test.com');
  const A = await env.cityId('Almaty, KZ'); const T = await env.cityId('Tashkent, UZ');
  const base = validLoad(A, T);
  const { contactPhone, contactEmail, contactTelegram, ...rest } = base;

  const none = await api.post('/api/loads', { ...rest });
  assert.equal(none.status, 400);
  assert.deepEqual(none.json.error.details.map((d) => d.path).sort(), ['contactPhone', 'contactTelegram']);
  assert.equal(none.json.error.details[0].code, 'contact_required');

  assert.equal((await api.post('/api/loads', { ...rest, contactPhone })).status, 201, 'phone alone, no e-mail, no Telegram');
  const tgOnly = await api.post('/api/loads', { ...rest, contactTelegram });
  assert.equal(tgOnly.status, 201, 'Telegram alone');
  assert.equal(tgOnly.json.contactPhone, '');
  assert.equal(tgOnly.json.contactEmail, '');
  assert.equal((await api.post('/api/loads', { ...rest, contactEmail })).status, 400, 'e-mail alone is not a way to be reached');

  // editing: omitted contacts are kept, and the last contact cannot be removed
  const edited = await api.patch(`/api/loads/${tgOnly.json.id}`, { rateUsd: 111 });
  assert.equal(edited.json.contactTelegram, contactTelegram);
  assert.equal((await api.patch(`/api/loads/${tgOnly.json.id}`, { contactTelegram: '' })).status, 400);
  assert.equal((await api.patch(`/api/loads/${tgOnly.json.id}`, { contactTelegram: '', contactPhone })).status, 200);

  const truck = { locCityId: A, equip: 'T', capacityT: 20, availableFrom: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) };
  assert.equal((await api.post('/api/trucks', truck)).status, 400);
  assert.equal((await api.post('/api/trucks', { ...truck, contactTelegram })).status, 201);
  assert.equal((await api.post('/api/trucks', { ...truck, contactPhone })).status, 201);
});
