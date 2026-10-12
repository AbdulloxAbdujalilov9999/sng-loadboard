import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { makeBot } from '../src/bot.js';
import { parseEditValue } from '../src/myLoads.js';
import { formatLoadMessage, formatNotes } from '../src/format.js';

const NOW = new Date('2026-10-12T10:00:00Z'); // 15:00 in Tashkent

test('what people type becomes the right field', () => {
  assert.deepEqual(parseEditValue('rate', '1500'), { rateUsd: 1500 });
  assert.deepEqual(parseEditValue('rate', '$1 500,5'), { rateUsd: 1500.5 });
  assert.deepEqual(parseEditValue('rate', '0'), { rateUsd: 0 });
  assert.deepEqual(parseEditValue('rate', 'Kelishiladi'), { rateUsd: 0 });
  assert.equal(parseEditValue('rate', 'abc'), null);
  assert.equal(parseEditValue('rate', '-5'), null);
  assert.deepEqual(parseEditValue('date', 'bugun', NOW), { pickupDate: '2026-10-12' });
  assert.deepEqual(parseEditValue('date', 'ЗАВТРА', NOW), { pickupDate: '2026-10-13' });
  assert.deepEqual(parseEditValue('date', '15.10', NOW), { pickupDate: '2026-10-15' });
  assert.deepEqual(parseEditValue('date', '2026-11-02', NOW), { pickupDate: '2026-11-02' });
  assert.deepEqual(parseEditValue('date', '03.01', new Date('2026-12-28T10:00:00Z')), { pickupDate: '2027-01-03' }, 'a January date typed in December is next year');
  assert.equal(parseEditValue('date', '31.02', NOW), null);
  assert.equal(parseEditValue('date', 'soon', NOW), null);
  assert.deepEqual(parseEditValue('weight', '21,5 t'), { weightT: 21.5 });
  assert.deepEqual(parseEditValue('weight', '22'), { weightT: 22 });
  assert.equal(parseEditValue('weight', '0'), null);
  assert.equal(parseEditValue('weight', '500'), null);
  assert.deepEqual(parseEditValue('notes', '-'), { notes: '' });
  assert.deepEqual(parseEditValue('notes', 'Avans bor'), { notes: 'Avans bor' });
  assert.deepEqual(parseEditValue('phone', '+998 90 123 45 67'), { contactPhone: '+998901234567' });
  assert.deepEqual(parseEditValue('phone', '901234567'), { contactPhone: '+998901234567' });
  assert.equal(parseEditValue('phone', '123'), null);
  assert.deepEqual(parseEditValue('telegram', 'bek_disp'), { contactTelegram: '@bek_disp' });
  assert.deepEqual(parseEditValue('telegram', 'https://t.me/bek_disp'), { contactTelegram: '@bek_disp' });
  assert.equal(parseEditValue('telegram', 'a b'), null);
  assert.equal(parseEditValue('nonsense', 'x'), null);
});

test('the message lists the notes instead of one long line, and sets the AI guess apart', () => {
  const lines = formatNotes('Без перегруза · Груз готов ✅ · Срочно 🚀 · Taxminiy: sana — telefon orqali aniqlang', 'uz');
  assert.deepEqual(lines, ['📝 Izoh:', '• Без перегруза', '• Груз готов ✅', '• Срочно 🚀', '⚠️ <i>Taxminiy: sana — telefon orqali aniqlang</i>']);
  assert.deepEqual(formatNotes('Avans bor', 'uz'), ['📝 Avans bor']);
  assert.deepEqual(formatNotes('', 'uz'), []);
  const msg = formatLoadMessage({
    origin_city: 'Perm, RU', dest_city: 'Andijan, UZ', equip: 'T', fp: 'Full', weight_t: 22, volume_m3: 120, pickup_date: '2026-10-12', distance_km: 2675,
    rate_usd: 0, commodity: 'Ламинат', notes: 'Срочно 🚀', company_name: 'Abdulloh', contact_name: 'Abdulloh', contact_phone: '+998938747080', contact_tg: '@Abdujalilov_077',
  }, 'uz', 'https://sng-pro.com/?load=1');
  assert.match(msg, /Tent \(Shtorali\) · Toʻliq/, 'no double brackets');
  assert.match(msg, /💰 Kelishiladi/);
  assert.match(msg, /👤 Abdulloh\n📞 \+998938747080\n✈️ @Abdujalilov_077/);
  assert.match(msg, /Birjada koʻrish/);
});

// ---- the real bot wiring, with a fake Telegram and a fake API ----
const realCallApi = Telegram.prototype.callApi;
let record = () => {};
Telegram.prototype.callApi = async function fake(method, payload) { return record(method, payload); };
process.on('exit', () => { Telegram.prototype.callApi = realCallApi; });

function setup() {
  const sent = []; const calls = [];
  let loads = [{
    id: 7, originCity: 'Perm, RU', destCity: 'Andijan, UZ', equip: 'T', fp: 'Full', weightT: 22, volumeM3: 120, pickupDate: '2026-10-12', deliveryDate: null,
    distanceKm: 2675, rateUsd: 0, commodity: 'Ламинат', notes: 'Без перегруза · Срочно 🚀', company: 'Abdulloh', contactName: 'Abdulloh', contactPhone: '+998938747080', contactEmail: '', contactTelegram: '@Abdujalilov_077',
  }];
  const apiClient = {
    listMine: async () => ({ items: loads }),
    updateLoad: async (_t, id, patch) => { calls.push(['update', id, patch]); if (patch.rateUsd === 999999) { const { ApiError } = await import('../src/apiClient.js'); throw new ApiError(400, 'validation_error', 'bad', [{ path: 'rateUsd', code: 'too_big' }]); } loads = loads.map((l) => (l.id === id ? { ...l, ...patch } : l)); return loads.find((l) => l.id === id); },
    renewLoad: async (_t, id) => { calls.push(['renew', id]); return loads.find((l) => l.id === id); },
    deleteLoad: async (_t, id) => { calls.push(['delete', id]); loads = loads.filter((l) => l.id !== id); },
  };
  const config = { botToken: '123:test', broadcastLang: 'uz', joinChannel: '', joinGroup: '', aiMaxPerMin: 600, pendingTtlMin: 15, webBaseUrl: 'https://x', webUrlIsPublic: true };
  const store = { getLanguage: async () => null, setLanguage: async () => {}, getLinkByTelegramUserId: async () => null, removeLink: async () => false };
  const bot = makeBot({ config, firebaseAuth: {}, apiClient, tokens: { getIdToken: async () => 'tok', invalidate() {} }, store });
  bot.botInfo = { id: 123, is_bot: true, first_name: 'sng', username: 'sng_test_bot' };
  record = (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length, chat: { id: 77 }, date: 0, text: payload.text }; };
  let n = 0;
  const from = { id: 77, is_bot: false, first_name: 'Bek', language_code: 'uz' };
  const say = (text) => bot.handleUpdate({ update_id: ++n, message: { message_id: n, date: 0, text, from, chat: { id: 77, type: 'private' }, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] } : {}) } });
  const press = (data) => bot.handleUpdate({ update_id: ++n, callback_query: { id: String(n), from, chat_instance: 'x', data, message: { message_id: 50, date: 0, chat: { id: 77, type: 'private' }, text: 'card' } } });
  const last = (method) => sent.filter((s) => s.method === method).at(-1);
  const buttons = (s) => (s?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  return { say, press, last, calls, sent, buttons };
}

test('/myloads shows the whole load with Edit, Renew and Delete buttons', async () => {
  const { say, last, buttons } = setup();
  await say('/myloads');
  const card = last('sendMessage');
  assert.match(card.text, /Perm, RU → Andijan, UZ/);
  assert.match(card.text, /Ламинат/);
  assert.match(card.text, /22 t · 120 m³/);
  assert.match(card.text, /Kelishiladi/);
  assert.match(card.text, /📞 \+998938747080/);
  assert.deepEqual(buttons(card), ['myloads:edit:7', 'myloads:renew:7', 'myloads:ask:7']);
});

test('delete asks first and shows the whole load, then removes it', async () => {
  const { press, last, calls, buttons } = setup();
  await press('myloads:ask:7');
  const ask = last('editMessageText');
  assert.match(ask.text, /Ламинат/);
  assert.match(ask.text, /Bu yukni birjadan/);
  assert.deepEqual(buttons(ask), ['myloads:del:7', 'myloads:card:7']);
  await press('myloads:card:7');
  assert.ok(buttons(last('editMessageText')).includes('myloads:edit:7'), '"No" brings the card back');
  await press('myloads:del:7');
  assert.deepEqual(calls.at(-1), ['delete', 7]);
  assert.match(last('editMessageText').text, /Oʻchirildi: Perm, RU → Andijan, UZ/);
  await press('myloads:ask:7');
  assert.match(last('editMessageText').text, /endi birjada yoʻq/, 'a load that is gone says so');
});

test('edit: pick a field, type the new value, see the updated card; /cancel and other commands drop the edit', async () => {
  const { say, press, last, calls, sent } = setup();
  await press('myloads:edit:7');
  assert.ok(sent.some((s) => s.method === 'editMessageText' && /Nimani oʻzgartiramiz/.test(s.text)));
  await press('myloads:f:7:rate');
  assert.match(last('sendMessage').text, /Yangi narxni/);
  await say('abc');
  assert.match(last('sendMessage').text, /qabul qilinmadi/);
  assert.equal(calls.length, 0, 'a bad value is never sent');
  await say('1500');
  assert.deepEqual(calls.at(-1), ['update', 7, { rateUsd: 1500 }]);
  assert.match(last('sendMessage').text, /Saqlandi[\s\S]*\$1,500/);
  // the edit is over: plain text is a paste again, not a value
  const n = sent.length; await say('1600');
  assert.ok(!calls.some((c) => c[2]?.rateUsd === 1600));
  assert.ok(sent.length > n);
  // /cancel
  await press('myloads:f:7:date');
  await say('/cancel');
  assert.match(last('sendMessage').text, /Bekor qilindi/);
  // another command also ends the edit
  await press('myloads:f:7:weight');
  await say('/mystatus');
  await say('25');
  assert.ok(!calls.some((c) => c[2]?.weightT === 25));
  // the server's own rejection is shown and the edit stays open
  await press('myloads:f:7:rate');
  await say('999999');
  assert.match(last('sendMessage').text, /rateUsd: too_big/);
  await say('800');
  assert.deepEqual(calls.at(-1), ['update', 7, { rateUsd: 800 }]);
});

test('renew keeps the load and says so', async () => {
  const { press, last, calls } = setup();
  await press('myloads:renew:7');
  assert.deepEqual(calls.at(-1), ['renew', 7]);
  assert.match(last('editMessageText').text, /Uzaytirildi/);
});
