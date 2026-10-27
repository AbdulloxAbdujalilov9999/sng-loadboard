import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBroadcaster } from '../src/broadcaster.js';
import { formatLoadMessage, dtoToRow } from '../src/format.js';
import { loadKeyboard } from '../src/editor.js';

const ROW = {
  id: 5, owner_id: 7, status: 'active', origin_city: 'Tashkent, UZ', dest_city: 'Moscow, RU', equip: 'T', fp: 'Full',
  weight_t: '20.00', volume_m3: null, pickup_date: '2026-03-15', delivery_date: null, distance_km: 3200,
  rate_usd: '1500.00', commodity: 'Furniture', notes: '', company_name: 'Acme', contact_name: 'Bek',
  contact_phone: '+998901234567', contact_email: '', contact_tg: '@bek', owner_verified: true,
};

function fixture(config = {}) {
  const pool = { query: async (sql) => (sql.includes('FROM loads') ? { rows: [ROW] } : { rows: [] }) };
  const sent = [];
  const store = {
    listActiveChatIds: async () => [111, 333],
    markChatRemoved: async () => {},
    getTelegramUserIdByMemberId: async (id) => (id === 9 ? 999 : 444),
    saveSentMessage: async () => {}, listSentMessages: async () => [], deleteSentMessages: async () => {},
  };
  const bot = { telegram: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 }; } } };
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: 'x', broadcastLang: 'en', webBaseUrl: 'https://sng.example', ...config },
    pool, store, bot, log: { warn() {}, error() {} }, sleep: async () => {},
  });
  return { broadcaster, sent };
}

test('a repost goes to every group again, headed «Still available», and not to the poster\'s own chat', async () => {
  const { broadcaster, sent } = fixture();
  await broadcaster._handleEvent({ entity: 'loads', op: 'repost', id: 5, ownerId: 7 });
  assert.deepEqual(sent.map((s) => s.chatId), [111, 333]);
  assert.match(sent[0].text, /^<b>🔁 Still available<\/b>\n🚚 <b>Tashkent, UZ → Moscow, RU<\/b>/);
});

test('a TOP purchase is reposted with the TOP tag', async () => {
  const { broadcaster, sent } = fixture();
  await broadcaster._handleEvent({ entity: 'loads', op: 'repost', id: 5, ownerId: 7, top: true });
  assert.match(sent[0].text, /⭐ TOP load/);
});

test('referral notices are sent only by the process that has them switched on', async () => {
  const off = fixture();
  await off.broadcaster._handleEvent({ entity: 'referralReward', op: 'notify', memberId: 9, credits: 2 });
  assert.equal(off.sent.length, 0);
  const on = fixture({ sendReferralNotices: true });
  await on.broadcaster._handleEvent({ entity: 'referralReward', op: 'notify', memberId: 9, credits: 2 });
  assert.equal(on.sent.length, 1);
  assert.equal(on.sent[0].chatId, 999);
  assert.match(on.sent[0].text, /You got 2 TOP credit/);
});

test('verified members get a line in every load message, in each language', () => {
  assert.match(formatLoadMessage(ROW, 'en'), /✅ Verified company/);
  assert.match(formatLoadMessage(ROW, 'ru'), /✅ Проверенная компания/);
  assert.doesNotMatch(formatLoadMessage({ ...ROW, owner_verified: false }, 'uz'), /Tasdiqlangan/);
  assert.equal(dtoToRow({ verified: true }).owner_verified, true);
});

test('the buttons under a posted load include Repost and TOP', () => {
  const data = loadKeyboard('en', 42).reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('myloads:repost:42'));
  assert.ok(data.includes('myloads:top:42'));
});
