import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestEnv } from './helpers.js';

const BOT_TOKEN = '123456:test-bot-token-for-signature-only';

/** Signs a Telegram Mini App initData string exactly the way Telegram itself does, so the server's
 * real HMAC verification (server/src/lib/telegramAuth.js) accepts it like a genuine launch. */
function initDataFor(user, { authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'AAtest', user: JSON.stringify(user) });
  const dataCheckString = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

let env;
before(async () => { env = await startTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }); });
after(async () => { await env.close(); });

test('a classic-linked member (telegram_links, never written to members) is recognized by Mini App sign-in', async () => {
  const member = await env.approvedMember('classic-link@test.com');
  const telegramUserId = 555111222;
  await env.pool.query(
    `INSERT INTO telegram_links (member_id, telegram_user_id, telegram_username, refresh_token_enc) VALUES ($1, $2, 'classic_user', 'enc')`,
    [member.id, telegramUserId],
  );
  // Confirm the fixture matches production shape: linking never touches members.telegram_user_id.
  const { rows: [row] } = await env.pool.query('SELECT telegram_user_id FROM members WHERE id = $1', [member.id]);
  assert.equal(row.telegram_user_id, null);

  const initData = initDataFor({ id: telegramUserId, first_name: 'Classic' });
  const res = await env.anon().post('/api/auth/telegram', { initData });
  assert.equal(res.status, 200);
  assert.ok(res.json.token);

  const me = await env.withToken(res.json.token).get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.status, 'approved', 'should resolve to the existing member, not a fresh ghost identity');
  assert.equal(me.json.profile.id, member.id);
});

test('a brand-new Telegram user gets a session with no existing account (status: none)', async () => {
  const initData = initDataFor({ id: 999888777, first_name: 'New' });
  const res = await env.anon().post('/api/auth/telegram', { initData });
  assert.equal(res.status, 200);

  const me = await env.withToken(res.json.token).get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.status, 'none');
});

test('a member who signed up through the Mini App itself (members.telegram_user_id) is still recognized', async () => {
  const telegramUserId = 444333222;
  const initData = initDataFor({ id: telegramUserId, first_name: 'MiniApp' });
  const signup = await env.anon().post('/api/auth/telegram', { initData });
  await env.withToken(signup.json.token).post('/api/me/access-request', { contactName: 'Mini App Native', telegram: '@native' });

  const res = await env.anon().post('/api/auth/telegram', { initData });
  const me = await env.withToken(res.json.token).get('/api/me');
  assert.equal(me.json.status, 'approved');
  assert.equal(me.json.profile.contactName, 'Mini App Native');
});

test('rejects garbage or unsigned initData', async () => {
  const bad = await env.anon().post('/api/auth/telegram', { initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' });
  assert.equal(bad.status, 401);
  const empty = await env.anon().post('/api/auth/telegram', {});
  assert.equal(empty.status, 401);
});
