import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { startTestEnv, validLoad } from './helpers.js';

let env;
const PHONE = '+998901112233';
before(async () => { env = await startTestEnv(); });
after(async () => { await env.close(); });

const login = (phone, pin, purpose) => env.anon().post('/api/auth/pin/login', { phone, pin, ...(purpose ? { purpose } : {}) });

test('PIN sign-in: sign up by SMS once, then phone + PIN gets a session (no SMS)', async () => {
  const sms = env.as(PHONE);
  assert.deepEqual((await env.anon().post('/api/auth/phone/check', { phone: PHONE })).json, { hasPin: false }, 'unknown number: SMS flow');
  assert.equal((await sms.post('/api/me/access-request', { contactName: 'Aziz', pin: '4729' })).status, 201);
  assert.deepEqual((await env.anon().post('/api/auth/phone/check', { phone: PHONE })).json, { hasPin: true }, 'now the form asks for the PIN');

  const ok = await login(PHONE, '4729');
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.json.token && ok.json.expiresAt);
  const me = await env.withToken(ok.json.token).get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.provider, 'pin');
  assert.equal(me.json.login, PHONE);
  assert.equal(me.json.status, 'approved');
  assert.equal(me.json.profile.hasPin, true);
  assert.ok(!JSON.stringify(me.json).includes('scrypt'), 'the hash never leaves the server');

  // a PIN session works like any other: post a load
  const posted = await env.withToken(ok.json.token).post('/api/loads', validLoad(await env.cityId('Almaty, KZ'), await env.cityId('Tashkent, UZ')));
  assert.equal(posted.status, 201);
  const { rows: [row] } = await env.pool.query('SELECT pin_hash FROM members WHERE phone = $1', [PHONE]);
  assert.match(row.pin_hash, /^scrypt1\$/);
  assert.ok(!row.pin_hash.includes('4729'));
});

test('wrong PIN: same answer as an unknown number; 5 wrong tries lock PIN sign-in for 15 minutes', async () => {
  const phone = '+998905550000';
  await env.as(phone).post('/api/me/access-request', { contactName: 'Lock Test', pin: '7391' });
  const unknown = await login('+998900000001', '7391');
  const wrong = await login(phone, '1357');
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.json.error.message, wrong.json.error.message, 'nobody can probe which numbers exist');

  for (let i = 0; i < 4; i += 1) assert.equal((await login(phone, '1357')).status, 401);
  const locked = await login(phone, '7391'); // even the RIGHT pin is refused while locked
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'pin_locked');
  // SMS sign-in is unaffected, and choosing a new PIN with it lifts the lock
  const reset = await env.as(phone).put('/api/me/pin', { pin: '8264' });
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal((await login(phone, '8264')).status, 200);
  assert.equal((await login(phone, '7391')).status, 401, 'the old PIN no longer works');
});

test('changing the PIN ends other PIN sessions; the device that changed it stays signed in', async () => {
  const phone = '+998906660000';
  await env.as(phone).post('/api/me/access-request', { contactName: 'Change Test', pin: '5821' });
  const a = (await login(phone, '5821')).json.token;
  const b = (await login(phone, '5821', 'bot')).json.token; // e.g. the Telegram bot
  assert.equal((await env.withToken(a).get('/api/me')).status, 200);

  assert.equal((await env.withToken(a).put('/api/me/pin', { pin: '6032' })).status, 400, 'needs the current PIN');
  assert.equal((await env.withToken(a).put('/api/me/pin', { pin: '6032', currentPin: '0000' })).status, 400, 'wrong current PIN');
  assert.equal((await env.withToken(a).put('/api/me/pin', { pin: '1111', currentPin: '5821' })).json.error.details[0].code, 'pin_weak');
  await new Promise((r) => setTimeout(r, 1100)); // tokens carry whole-second issue times
  const changed = await env.withToken(a).put('/api/me/pin', { pin: '6032', currentPin: '5821' });
  assert.equal(changed.status, 200);
  assert.ok(changed.json.token, 'the changing device gets a fresh session');
  assert.equal((await env.withToken(a).get('/api/me')).status, 401, 'the old session ended');
  assert.equal((await env.withToken(b).get('/api/me')).status, 401, 'so did the bot link');
  assert.equal((await env.withToken(changed.json.token).get('/api/me')).status, 200);
});

test('PIN rules: exactly 4 digits, no obvious PINs, phone sign-ups only, owner never signs in with a PIN', async () => {
  const phone = '+998907770000';
  for (const pin of ['123', '12345', 'abcd', '12 4']) {
    const r = await env.as(phone).post('/api/me/access-request', { contactName: 'X', pin });
    assert.equal(r.status, 400, pin);
  }
  assert.equal((await env.as(phone).post('/api/me/access-request', { contactName: 'X', pin: '0000' })).json.error.details[0].code, 'pin_weak');
  // Google / e-mail accounts do not use PINs
  await env.approvedMember('g@test.com');
  assert.equal((await env.as('g@test.com').put('/api/me/pin', { pin: '4729' })).status, 403);
  // the owner is an e-mail identity: there is no phone for a PIN login to find
  assert.equal((await login('+998900000009', '4729')).status, 401);
  assert.equal((await env.pool.query("SELECT 1 FROM members WHERE role = 'owner' AND pin_hash IS NOT NULL")).rowCount, 0);
});

test('session tokens: forged, wrong-secret and expired tokens are refused; refresh issues a new one', async () => {
  const phone = '+998908880000';
  await env.as(phone).post('/api/me/access-request', { contactName: 'Token Test', pin: '3947' });
  const good = (await login(phone, '3947')).json.token;

  const forge = (secret, alg = 'HS256', expiresIn = '1h') => new SignJWT({ ph: phone, pr: 'web' }).setProtectedHeader({ alg })
    .setSubject('p998908880000@phone.sng').setIssuer('sng-one').setAudience('sng-one-pin').setIssuedAt().setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
  assert.equal((await env.withToken(await forge('attacker-secret-attacker-secret')).get('/api/me')).status, 401, 'signed with another secret');
  assert.equal((await env.withToken(`${good.slice(0, -4)}AAAA`).get('/api/me')).status, 401, 'tampered signature');
  assert.equal((await env.withToken(good.split('.').slice(0, 2).join('.') + '.').get('/api/me')).status, 401, 'no signature');

  const fresh = await env.withToken(good).post('/api/auth/refresh');
  assert.equal(fresh.status, 200);
  assert.ok(fresh.json.token);
  assert.equal((await env.withToken(fresh.json.token).get('/api/me')).status, 200);
  assert.equal((await env.as(phone).post('/api/auth/refresh')).status, 404, 'only PIN sessions refresh this way');
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
