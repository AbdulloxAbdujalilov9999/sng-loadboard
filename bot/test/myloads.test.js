import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { makeBot } from '../src/bot.js';
import { parseEditValue } from '../src/editor.js';
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

function setup({ debounce = 0 } = {}) {
  const sent = []; const calls = []; const parsed = [];
  let loads = [{
    id: 7, originCity: 'Perm, RU', destCity: 'Andijan, UZ', equip: 'T', fp: 'Full', weightT: 22, volumeM3: 120, pickupDate: '2026-10-12', deliveryDate: null,
    distanceKm: 2675, rateUsd: 0, commodity: 'Ламинат', notes: 'Без перегруза · Срочно 🚀', company: 'Abdulloh', contactName: 'Abdulloh', contactPhone: '+998938747080', contactEmail: '', contactTelegram: '@Abdujalilov_077',
  }];
  const apiClient = {
    listMine: async () => ({ items: loads }),
    updateLoad: async (_t, id, patch) => { calls.push(['update', id, patch]); if (patch.rateUsd === 999999) { const { ApiError } = await import('../src/apiClient.js'); throw new ApiError(400, 'validation_error', 'bad', [{ path: 'rateUsd', code: 'too_big' }]); } loads = loads.map((l) => (l.id === id ? { ...l, ...patch } : l)); return loads.find((l) => l.id === id); },
    renewLoad: async (_t, id) => { calls.push(['renew', id]); return loads.find((l) => l.id === id); },
    deleteLoad: async (_t, id) => { calls.push(['delete', id]); loads = loads.filter((l) => l.id !== id); },
    searchCities: async (_t, q) => (/^tom/i.test(q) ? { items: [{ id: 5, label: 'Tomsk, RU' }, { id: 6, label: 'Tomsk Oblast, RU' }] } : { items: [] }),
    getMe: async () => ({ profile: { id: 1, status: 'approved', company: 'Abdulloh', phone: '+998938747080', contactName: 'Abdulloh' } }),
    parseLoads: async (_t, text) => { parsed.push(text); return ({ truncated: false, loads: [
      { originCityId: 1, originCity: 'Perm, RU', destCityId: 2, destCity: 'Andijan, UZ', equip: 'T', fp: 'Full', weightT: 22, volumeM3: 120, pickupDate: '2026-10-12', rateUsd: 0, commodity: 'Ламинат', notes: 'Срочно', contactPhone: '+998938747080', contactTelegram: '', contactName: '', flags: ['date'] },
      { originCityId: null, originCity: '', originText: 'Питр', destCityId: 2, destCity: 'Andijan, UZ', equip: 'T', fp: 'Full', weightT: 20, volumeM3: null, pickupDate: '2026-10-13', rateUsd: 500, commodity: 'Тент', notes: '', contactPhone: '', contactTelegram: '', contactName: '', flags: ['origin'] },
    ] }); },
    createLoadsBulk: async (_t, bodies) => { calls.push(['bulk', bodies]); return { items: bodies.map((b, i) => ({ id: 100 + i, originCity: 'x', destCity: 'y', pickupDate: b.pickupDate, rateUsd: b.rateUsd })) }; },
  };
  const config = { botToken: '123:test', broadcastLang: 'uz', joinChannel: '', joinGroup: '', aiMaxPerMin: 600, pendingTtlMin: 15, pasteDebounceMs: debounce, webBaseUrl: 'https://x', webUrlIsPublic: true };
  const state = { link: null, removed: 0, lang: null };
  const store = { getLanguage: async () => state.lang, setLanguage: async (_id, l) => { state.lang = l; }, getLinkByTelegramUserId: async () => state.link, removeLink: async () => { state.removed += 1; return true; } };
  const bot = makeBot({ config, firebaseAuth: {}, apiClient, tokens: { getIdToken: async () => 'tok', invalidate() {} }, store });
  bot.botInfo = { id: 123, is_bot: true, first_name: 'sng', username: 'sng_test_bot' };
  record = (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length, chat: { id: 77 }, date: 0, text: payload.text }; };
  let n = 0;
  const from = { id: 77, is_bot: false, first_name: 'Bek', language_code: 'uz' };
  const say = (text) => bot.handleUpdate({ update_id: ++n, message: { message_id: n, date: 0, text, from, chat: { id: 77, type: 'private' }, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] } : {}) } });
  const press = (data) => bot.handleUpdate({ update_id: ++n, callback_query: { id: String(n), from, chat_instance: 'x', data, message: { message_id: 50, date: 0, chat: { id: 77, type: 'private' }, text: 'card' } } });
  const last = (method) => sent.filter((s) => s.method === method).at(-1);
  const buttons = (s) => (s?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  const keyboardOf = (m) => (m?.reply_markup?.keyboard ?? []).map((row) => row.map((b) => b.text ?? b));
  return { say, press, last, calls, sent, buttons, state, keyboardOf, parsed };
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
  assert.deepEqual(buttons(card), ['ed:menu:L7', 'myloads:renew:7', 'myloads:ask:7']);
});

test('delete asks first and shows the whole load, then removes it', async () => {
  const { press, last, calls, buttons } = setup();
  await press('myloads:ask:7');
  const ask = last('editMessageText');
  assert.match(ask.text, /Ламинат/);
  assert.match(ask.text, /Bu yukni birjadan/);
  assert.deepEqual(buttons(ask), ['myloads:del:7', 'myloads:card:7']);
  await press('myloads:card:7');
  assert.ok(buttons(last('editMessageText')).includes('ed:menu:L7'), '"No" brings the card back');
  await press('myloads:del:7');
  assert.deepEqual(calls.at(-1), ['delete', 7]);
  assert.match(last('editMessageText').text, /Oʻchirildi: Perm, RU → Andijan, UZ/);
  await press('myloads:ask:7');
  assert.match(last('editMessageText').text, /endi birjada yoʻq/, 'a load that is gone says so');
});

test('edit: pick a field, type the new value, see the updated card; /cancel and other commands drop the edit', async () => {
  const { say, press, last, calls, sent } = setup();
  await press('ed:menu:L7');
  const menu = sent.find((s) => s.method === 'editMessageText' && /Nimani oʻzgartiramiz/.test(s.text));
  assert.ok(menu);
  assert.equal((menu.reply_markup.inline_keyboard.flat().length), 15, 'every field of the platform\'s edit window + Back');
  await press('ed:f:L7:rate');
  assert.match(last('sendMessage').text, /Yangi narxni/);
  await say('abc');
  assert.match(last('sendMessage').text, /qabul qilinmadi/);
  assert.equal(calls.length, 0, 'a bad value is never sent');
  await say('1500');
  assert.deepEqual(calls.at(-1), ['update', 7, { rateUsd: 1500 }]);
  assert.match(last('sendMessage').text, /Saqlandi/);
  assert.match(last('editMessageText').text, /\$1,500/, 'the card the person pressed Edit on is updated in place');
  // the edit is over: plain text is a paste again, not a value
  const n = sent.length; await say('1600');
  assert.ok(!calls.some((c) => c[2]?.rateUsd === 1600));
  assert.ok(sent.length > n);
  // /cancel
  await press('ed:f:L7:date');
  await say('/cancel');
  assert.match(last('sendMessage').text, /Bekor qilindi/);
  // another command also ends the edit
  await press('ed:f:L7:weight');
  await say('/mystatus');
  await say('25');
  assert.ok(!calls.some((c) => c[2]?.weightT === 25));
  // the server's own rejection is shown and the edit stays open
  await press('ed:f:L7:rate');
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

test('edit offers the truck type and full/partial as buttons, and finds cities by name', async () => {
  const { say, press, last, calls, buttons, sent } = setup();
  await press('ed:f:L7:equip');
  assert.deepEqual(buttons(last('editMessageText')).filter((b) => b.startsWith('ed:set')), ['ed:set:L7:equip:T', 'ed:set:L7:equip:R', 'ed:set:L7:equip:F', 'ed:set:L7:equip:V', 'ed:set:L7:equip:AC']);
  await press('ed:set:L7:equip:R');
  assert.deepEqual(calls.at(-1), ['update', 7, { equip: 'R' }]);
  await press('ed:set:L7:fp:Partial');
  assert.deepEqual(calls.at(-1), ['update', 7, { fp: 'Partial' }]);
  await press('ed:set:L7:equip:ZZ');
  assert.notDeepEqual(calls.at(-1), ['update', 7, { equip: 'ZZ' }], 'only the offered values are accepted');

  await press('ed:f:L7:origin');
  await say('tomsk');
  assert.deepEqual(buttons(last('sendMessage')).filter((b) => b.startsWith('ed:city')), ['ed:city:5', 'ed:city:6']);
  await press('ed:city:5');
  assert.deepEqual(calls.at(-1), ['update', 7, { originCityId: 5 }]);
  await press('ed:f:L7:dest');
  await say('nowhere');
  assert.match(last('sendMessage').text, /Bunday shahar topilmadi/);

  await press('ed:f:L7:volume'); await say('82');
  assert.deepEqual(calls.at(-1), ['update', 7, { volumeM3: 82 }]);
  await press('ed:f:L7:delivery'); await say('-');
  assert.deepEqual(calls.at(-1), ['update', 7, { deliveryDate: null }]);
  await press('ed:f:L7:name'); await say('Abdulloh Karimov');
  assert.deepEqual(calls.at(-1), ['update', 7, { contactName: 'Abdulloh Karimov' }]);
  assert.ok(sent.length > 0);
});

test('a pasted post: every load is its own message with Edit / Remove; fixes and removals show in the bottom message; posting sends only what is left', async () => {
  const { say, press, calls, sent, buttons } = setup();
  await say('/paste Perm Andijan Ламинат 22 тонн\nПитр Андижан Тент 20 т 500');
  const texts = sent.filter((s) => s.method === 'sendMessage');
  const drafts = texts.filter((s) => /^<b>#\d/.test(s.text));
  assert.equal(drafts.length, 2, 'one message per load');
  assert.deepEqual(buttons(drafts[0]).map((b) => b.split(':')[0] + ':' + b.split(':')[1]), ['ed:menu', 'pd:rm']);
  const footer = texts.at(-1);
  assert.match(footer.text, /1 ta|Joylashga tayyor/);
  const footerCount = () => sent.filter((s) => s.method === 'editMessageText' && /Joylashga tayyor/.test(s.text)).at(-1)?.text ?? footer.text;
  assert.match(footerCount(), /2 tadan 1 ta/, 'the second load has no city: 1 of 2 can be posted');

  // fix the second load's city -> both can be posted
  const key2 = buttons(drafts[1])[0].replace('ed:menu:', '');
  await press(`ed:f:${key2}:origin`);
  await say('tomsk');
  await press('ed:city:5');
  assert.match(footerCount(), /2 tadan 2 ta/, 'the bottom message follows the fix');
  const fixed = sent.filter((s) => s.method === 'editMessageText' && /Tomsk, RU/.test(s.text) && !/Joylash/.test(s.text)).at(-1);
  assert.ok(fixed, 'the load\'s own message shows the fix');

  // edit the first load's rate, then remove the second
  const key1 = buttons(drafts[0])[0].replace('ed:menu:', '');
  await press(`ed:f:${key1}:rate`);
  await say('900');
  await press(`pd:rm:${key2.slice(1)}`);
  assert.match(footerCount(), /1 tadan 1 ta/);
  assert.ok(sent.some((s) => s.method === 'editMessageText' && /olib tashlandi/i.test(s.text)));

  // post
  const confirm = buttons(sent.filter((s) => s.method === 'editMessageText' && /Joylashga tayyor/.test(s.text)).at(-1)).find((b) => b.startsWith('paste:confirm'));
  await press(confirm);
  const bulk = calls.find((c) => c[0] === 'bulk');
  assert.equal(bulk[1].length, 1, 'only the load that is still in the batch');
  assert.equal(bulk[1][0].rateUsd, 900, 'with the fixed rate');
  const summary = sent.filter((s) => s.method === 'editMessageText').at(-1).text;
  assert.match(summary, /1 ta yuk joylandi/);
  assert.doesNotMatch(summary, /Perm/, 'a short summary, not a list');
  await press(`pd:rm:${key1.slice(1)}`);
  assert.match(sent.filter((s) => s.method === 'editMessageText').at(-1).text, /eskirdi|expired/i, 'buttons of a finished batch do nothing');
});

test('the bottom menu: /start brings it, every button does what its command did, in the person\'s language', async () => {
  const { say, last, keyboardOf, sent, state, press, buttons } = setup();
  await say('/start');
  const welcome = last('sendMessage');
  assert.deepEqual(keyboardOf(welcome), [['📋 AI bilan joylash', '✍️ Bosqichma-bosqich'], ['📦 Mening yuklarim', '👤 Hisobim'], ['🌐 Til', 'ℹ️ Yordam']]);
  assert.equal(welcome.reply_markup.is_persistent, true, 'it stays at the bottom of the chat');
  assert.doesNotMatch(welcome.text, /\/link|\/postload|\/myloads/, 'the welcome talks about buttons, not commands');

  await say('📦 Mening yuklarim');
  assert.match(last('sendMessage').text, /Perm, RU → Andijan, UZ/, 'My loads lists the load cards');
  await say('📋 AI bilan joylash');
  assert.match(last('sendMessage').text, /Yuk postini shu yerga joylang/);
  await say('ℹ️ Yordam');
  assert.match(last('sendMessage').text, /Pastdagi tugmalardan foydalaning/);

  // My account: not linked -> connect buttons; linked -> status + disconnect, with a confirmation
  await say('👤 Hisobim');
  assert.deepEqual(buttons(last('sendMessage')), ['acct:link', 'acct:linkemail']);
  state.link = { company: 'Abdulloh', email: 'p998938747080@phone.sng', member_status: 'approved' };
  await say('👤 Hisobim');
  assert.match(last('sendMessage').text, /Abdulloh[\s\S]*\+998938747080/);
  assert.deepEqual(buttons(last('sendMessage')), ['acct:unlink']);
  await press('acct:unlink');
  assert.deepEqual(buttons(last('editMessageText')), ['acct:unlinkyes', 'acct:keep']);
  await press('acct:keep');
  assert.equal(state.removed, 0, 'nothing is disconnected until the person says yes');
  await press('acct:unlinkyes');
  assert.equal(state.removed, 1);

  // language: the labels change with it
  await say('🌐 Til');
  await press('lang:ru');
  assert.deepEqual(keyboardOf(last('sendMessage')), [['📋 Через AI', '✍️ По шагам'], ['📦 Мои грузы', '👤 Мой аккаунт'], ['🌐 Язык', 'ℹ️ Помощь']]);
  await say('📦 Мои грузы'); // the Russian label works too
  assert.match(sent.filter((s) => s.method === 'sendMessage').at(-1).text, /Perm, RU/);
});

test('a menu button ends a dialogue that is open: it is never taken as the answer to its question', async () => {
  const { say, press, last, calls } = setup();
  await say('✍️ Bosqichma-bosqich'); // starts the step-by-step posting: asks for the pickup city
  assert.match(last('sendMessage').text, /QAYERDAN/);
  await say('📦 Mening yuklarim');
  assert.match(last('sendMessage').text, /Perm, RU → Andijan, UZ/, 'the wizard did not swallow the tap');
  await say('1500'); // no dialogue is open any more: this is just text
  assert.ok(!last('sendMessage').text.includes('QAYERGA'), 'the posting dialogue is closed');

  await press('ed:f:L7:rate');
  await say('🌐 Til');
  await say('900');
  assert.ok(!calls.some((c) => c[0] === 'update'), 'a half-open edit is dropped when a menu button is tapped');
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('forwarding several posts at once is ONE paste: one AI call, one review, one Post button', async () => {
  const { say, sent, parsed, buttons } = setup({ debounce: 80 });
  await say('Perm Andijan Ламинат 22 тонн +998938747080');
  await wait(20);
  await say('Питр Андижан Тент 20 т 500$ +998938747081');
  await wait(20);
  await say('Москва Самарканд Мебель 18 тонн +998938747082');
  assert.equal(parsed.length, 0, 'nothing is read while the forwards are still coming in');
  await wait(300);
  assert.equal(parsed.length, 1, 'the whole burst is read once');
  assert.match(parsed[0], /Perm Andijan[\s\S]*Питр Андижан[\s\S]*Москва Самарканд/, 'all three posts are in that one text');
  const posts = sent.filter((s) => s.method === 'sendMessage' && buttons(s).some((b) => b.startsWith('paste:confirm')));
  assert.equal(posts.length, 1, 'exactly one "post" button');
});

test('a second paste a little later is a second review - the first one\'s Post button still works', async () => {
  const { say, press, sent, calls, buttons } = setup({ debounce: 30 });
  await say('Perm Andijan Ламинат 22 тонн +998938747080');
  await wait(200);
  await say('Perm Andijan Мебель 10 тонн +998938747080');
  await wait(200);
  const confirms = sent.filter((s) => s.method === 'sendMessage' && buttons(s).some((b) => b.startsWith('paste:confirm'))).map((s) => buttons(s)[0]);
  assert.equal(confirms.length, 2);
  await press(confirms[0]);
  assert.equal(calls.filter((c) => c[0] === 'bulk').length, 1, 'the earlier review can still be posted');
  await press(confirms[1]);
  assert.equal(calls.filter((c) => c[0] === 'bulk').length, 2);
  await press(confirms[0]);
  assert.match(sent.filter((s) => s.method === 'editMessageText').at(-1).text, /eskirdi/, 'a button that was already used does nothing twice');
});
