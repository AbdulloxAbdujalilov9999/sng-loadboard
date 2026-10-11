// /link with phone + 4-digit PIN, against the real API and database (only Telegram is faked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv } from '../../server/test/helpers.js';
import { makeApiClient } from '../src/apiClient.js';
import { makeBroadcaster } from '../src/broadcaster.js';
import { makeTokenManager, NotLinkedError, sessionExpiryMs, OWN_PREFIX } from '../src/tokens.js';
import { normalizePhone, performLink, linkFailureText } from '../src/linkScene.js';

let env; let api;
const PHONE = '+998901230001';
const register = (phone, pin, over = {}) => env.anon().post('/api/auth/phone/register', { phone, pin, contactName: 'Tester', ...over });
before(async () => {
  env = await startTestEnv();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  api = makeApiClient({ baseUrl: `http://127.0.0.1:${env.app.server.address().port}` });
  assert.equal((await register(PHONE, '482915', { contactName: 'Link Tester', company: 'Link Co' })).status, 201);
});
after(async () => { await env.close(); });

const fakeStore = () => { const links = new Map(); return {
  links,
  saveLink: async (l) => { links.set(l.telegramUserId, { ...l }); },
  getLinkByTelegramUserId: async (id) => (links.has(id) ? { refreshToken: links.get(id).refreshToken } : null),
  updateRefreshToken: async (id, token) => { links.get(id).refreshToken = token; },
}; };
const tokensOf = () => ({ invalidate() {} });
const login = (phone, pin) => env.anon().post('/api/auth/pin/login', { phone, pin });

test('phone numbers are understood in the usual ways', () => {
  assert.equal(normalizePhone('+998 90 123 00 01'), '+998901230001');
  assert.equal(normalizePhone('998901230001'), '+998901230001');
  assert.equal(normalizePhone('90 123 00 01'), '+998901230001', 'local Uzbek number');
  assert.equal(normalizePhone('+7 (913) 111-22-33'), '+79131112233');
  assert.equal(normalizePhone('00998901230001'), '+998901230001');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('hello'), null);
});

test('/link: the right phone + PIN stores a session; the bot then acts as that member', async () => {
  const store = fakeStore();
  const r = await performLink({ apiClient: api, store, tokens: tokensOf(), from: { id: 777, username: 'link_tester' }, phone: PHONE, pin: "482915" });
  assert.equal(r.ok, true);
  assert.equal(r.company, 'Link Co');
  const saved = store.links.get(777);
  assert.ok(saved.refreshToken.startsWith(OWN_PREFIX), 'stored as a server-issued session');
  assert.equal(saved.telegramUsername, 'link_tester');

  const manager = makeTokenManager({ store, firebaseAuth: null, apiClient: api });
  const token = await manager.getIdToken(777);
  const me = await api.getMe(token);
  assert.equal(me.profile.company, 'Link Co');
  assert.equal(me.provider, 'pin');
  assert.ok(sessionExpiryMs(token) - Date.now() > 100 * 86_400_000, 'a bot session lasts months');
  const renewed = await api.refreshSession(token);
  assert.equal((await api.getMe(renewed.token)).profile.company, 'Link Co', 'renewing gives a working session');
});

test('/link: wrong PIN and unknown number look the same; repeated misses lock it', async () => {
  const store = fakeStore();
  const link = (phone, pin) => performLink({ apiClient: api, store, tokens: tokensOf(), from: { id: 888 }, phone, pin });
  assert.equal((await link('+998900000099', '482915')).reason, 'wrong', 'unknown number');
  assert.equal((await link(PHONE, '1357')).reason, 'wrong');
  for (let i = 0; i < 4; i += 1) await link(PHONE, "1357"); // five misses in total
  const locked = await link(PHONE, '482915'); // even the right password is refused while locked
  assert.equal(locked.reason, 'locked');
  assert.ok(locked.min >= 1);
  assert.match(linkFailureText('en', locked), /Too many wrong passwords/);
  assert.ok(!store.links.has(888), 'nothing was linked');
});

test('a changed PIN ends the old link; expired sessions ask to /link again', async () => {
  const phone = '+998901230002';
  await register(phone, '582137', { contactName: 'Second' });
  const store = fakeStore();
  assert.equal((await performLink({ apiClient: api, store, tokens: tokensOf(), from: { id: 999 }, phone, pin: '582137' })).ok, true);
  const manager = makeTokenManager({ store, firebaseAuth: null, apiClient: api });
  assert.ok(await manager.getIdToken(999));
  await new Promise((r) => setTimeout(r, 1100));
  const changed = (await login(phone, '582137')).json.token;
  assert.equal((await env.withToken(changed).put('/api/me/pin', { pin: '603248', currentPin: '582137' })).status, 200);
  manager.invalidate(999);
  await assert.rejects(api.getMe(await manager.getIdToken(999)), (e) => e.status === 401, 'the API refuses the old session');

  store.links.set(1000, { refreshToken: `${OWN_PREFIX}a.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.c` });
  await assert.rejects(manager.getIdToken(1000), NotLinkedError, 'an expired session means "link again"');
});

test('the owner gets a Telegram message when someone signs up (not for the owner themselves)', async () => {
  await env.approvedMember('owner@test.com'); // owner row via the normal provisioning
  await env.as('owner@test.com').get('/api/me');
  const sent = [];
  const bot = { telegram: { sendMessage: async (id, text) => { sent.push({ id, text }); } } };
  const store = { listOwnerTelegramIds: async () => [4242], getLanguage: async () => 'uz', listActiveChatIds: async () => [], markChatRemoved: async () => {} };
  const b = makeBroadcaster({ config: { databaseUrl: env.config.databaseUrl, broadcastSpacingMs: 0, broadcastLang: 'en' }, pool: env.pool, store, bot, log: { warn() {}, error() {} }, sleep: async () => {} });
  const { rows: [m] } = await env.pool.query("SELECT id FROM members WHERE email LIKE 'p998901230001%'");
  await b._handleEvent({ entity: 'members', op: 'insert', id: m.id });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 4242);
  assert.match(sent[0].text, /Link Co/);
  assert.match(sent[0].text, /\+998901230001/);
  assert.ok(!/phone\.sng/.test(sent[0].text), 'the internal key never reaches a chat');
  assert.match(sent[0].text, /yangi aʼzo/, 'in the owner\'s language');
  const { rows: [o] } = await env.pool.query("SELECT id FROM members WHERE role = 'owner'");
  await b._handleEvent({ entity: 'members', op: 'insert', id: o.id });
  assert.equal(sent.length, 1, 'the owner is not told about themselves');
});
