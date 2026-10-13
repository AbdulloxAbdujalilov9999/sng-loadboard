import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { makeBot } from '../src/bot.js';
import { makeBroadcaster } from '../src/broadcaster.js';
import { parseEditValue } from '../src/editor.js';
import { formatMyTruck, formatTruckDraft } from '../src/format.js';

// ---- the real bot wiring, with a fake Telegram and a fake API ----
const realCallApi = Telegram.prototype.callApi;
let record = () => {};
Telegram.prototype.callApi = async function fake(method, payload) { return record(method, payload); };
process.on('exit', () => { Telegram.prototype.callApi = realCallApi; });

const SAVED = { equip: 'R', capacityT: 20, volumeM3: 82, hasTir: true, hasAdr: false, hasGps: true, sideLoading: false, locCityId: 88, locCity: 'Samarkand, UZ', destPref: '', plate: '01 A 123 BC', trailerPlate: '', driverName: 'Aziz', driverPhone: '', notes: '' };

function setup({ myTruck = null, trucks = [], parse = null } = {}) {
  const sent = []; const calls = [];
  const state = { myTruck, trucks: [...trucks], geo: { lat: null, lng: null, at: null, miles: 100 } };
  const truckDto = (id, o = {}) => ({ id, locCityId: 88, locCity: 'Samarkand, UZ', destPref: 'Moscow', equip: 'T', capacityT: 22, volumeM3: null, availableFrom: '2026-10-14', availableTo: null, minRateUsd: null, hasTir: true, hasAdr: false, hasGps: false, sideLoading: false, notes: '', company: 'Bek', contactPhone: '+998938747080', contactTelegram: '', ...o });
  const apiClient = {
    getMe: async () => ({ profile: { id: 1, status: 'approved', company: 'Bek', phone: '+998938747080', telegram: '@bek_disp', contactName: 'Bek', myTruck: state.myTruck } }),
    searchCities: async (_t, q) => (/^sam/i.test(q) ? { items: [{ id: 88, label: 'Samarkand, UZ' }, { id: 89, label: 'Samarkand Oblast, UZ' }] } : { items: [] }),
    createTruck: async (_t, body) => { calls.push(['createTruck', body]); const x = truckDto(900 + state.trucks.length, { ...body, locCity: 'Samarkand, UZ', company: 'Bek', contactTelegram: body.contactTelegram }); state.trucks.push(x); return x; },
    createTrucksBulk: async (_t, bodies) => { calls.push(['bulk', bodies]); const items = bodies.map((b, i) => truckDto(950 + i, { ...b, locCity: 'Samarkand, UZ' })); state.trucks.push(...items); return { items }; },
    parseTrucks: async (_t, text) => { calls.push(['parse', text]); if (parse) return parse(text); return { truncated: false, trucks: [
      { locCityId: 88, locCity: 'Samarkand, UZ', locText: 'Samarkand', destPref: 'Moscow', equip: 'T', capacityT: 20, volumeM3: null, availableFrom: '2026-10-14', availableTo: null, minRateUsd: 1800, hasTir: true, hasAdr: false, hasGps: false, sideLoading: false, notes: '', contactPhone: '+998901112233', contactTelegram: '', flags: [] },
      { locCityId: null, locCity: null, locText: '', destPref: 'Anywhere', equip: 'R', capacityT: 22, volumeM3: null, availableFrom: '2026-10-14', availableTo: null, minRateUsd: null, hasTir: false, hasAdr: false, hasGps: false, sideLoading: false, notes: '', contactPhone: '', contactTelegram: '', flags: ['location'] },
    ] }; },
    listMyTrucks: async () => ({ items: state.trucks }),
    updateTruck: async (_t, id, patch) => { calls.push(['updateTruck', id, patch]); state.trucks = state.trucks.map((x) => (x.id === id ? { ...x, ...patch } : x)); return state.trucks.find((x) => x.id === id); },
    renewTruck: async (_t, id) => { calls.push(['renewTruck', id]); return state.trucks.find((x) => x.id === id); },
    deleteTruck: async (_t, id) => { calls.push(['deleteTruck', id]); state.trucks = state.trucks.filter((x) => x.id !== id); },
    putMyTruck: async (_t, body) => { calls.push(['putMyTruck', body]); state.myTruck = { ...body, locCity: body.locCityId ? 'Samarkand, UZ' : '' , destPref: body.destPref ?? '', plate: body.plate ?? '', trailerPlate: body.trailerPlate ?? '', driverName: body.driverName ?? '', driverPhone: body.driverPhone ?? '', notes: body.notes ?? '', locCityId: body.locCityId ?? null }; return { profile: { myTruck: state.myTruck } }; },
    deleteMyTruck: async () => { calls.push(['deleteMyTruck']); state.myTruck = null; return { profile: { myTruck: null } }; },
    searchLoads: async (_t, params) => { calls.push(['searchLoads', params]); return { items: [{ id: 300, originCity: 'Near 0, UZ', destCity: 'Moscow, RU', equip: 'R', fp: 'Full', weightT: 18, volumeM3: null, pickupDate: '2026-10-14', deliveryDate: null, distanceKm: 3000, rateUsd: 900, commodity: 'Cargo', notes: '', company: 'Near Co', contactName: 'Bek', contactPhone: '+998901112233', contactEmail: '', contactTelegram: '@near_co', dho: 5 }], total: 1, nextCursor: null }; },
    searchTrucks: async () => ({ items: [], total: 0, nextCursor: null }),
  };
  const config = { botToken: '123:test', broadcastLang: 'uz', joinChannel: '', joinGroup: '', pasteDebounceMs: 0, draftGapMs: 0, nearGapMs: 0, cleanGapMs: 0, sleep: async () => {}, webBaseUrl: 'https://x', webUrlIsPublic: true };
  const store = {
    getLanguage: async () => null, setLanguage: async () => {}, getLinkByTelegramUserId: async () => null, removeLink: async () => true, saveLink: async () => {},
    getGeo: async () => ({ ...state.geo }),
    setGeo: async (_id, g) => { state.geo = { ...state.geo, lat: g.lat, lng: g.lng, at: new Date() }; },
    clearGeo: async () => {}, setGeoMiles: async () => {}, listSentMessages: async () => [], deleteSentMessages: async () => {},
  };
  const bot = makeBot({ config, firebaseAuth: {}, apiClient, tokens: { getIdToken: async () => 'tok', invalidate() {} }, store });
  bot.botInfo = { id: 123, is_bot: true, first_name: 'sng', username: 'sng_test_bot' };
  record = (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length, chat: { id: 77 }, date: 0, text: payload.text }; };
  let n = 0;
  const from = { id: 77, is_bot: false, first_name: 'Bek', language_code: 'uz' };
  const say = (text) => bot.handleUpdate({ update_id: ++n, message: { message_id: n, date: 0, text, from, chat: { id: 77, type: 'private' }, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] } : {}) } });
  const press = (data) => bot.handleUpdate({ update_id: ++n, callback_query: { id: String(n), from, chat_instance: 'x', data, message: { message_id: 50, date: 0, chat: { id: 77, type: 'private' }, text: 'card' } } });
  const location = (latitude, longitude) => bot.handleUpdate({ update_id: ++n, message: { message_id: n, date: 0, location: { latitude, longitude }, from, chat: { id: 77, type: 'private' } } });
  const msgs = () => sent.filter((s) => s.method === 'sendMessage');
  const last = () => msgs().at(-1);
  const buttons = (s) => (s?.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
  return { say, press, location, last, msgs, sent, calls, state, buttons };
}

test('typed truck values: capacity, free-from / until, minimum rate, plates, driver', () => {
  assert.deepEqual(parseEditValue('cap', '22'), { capacityT: 22 });
  assert.deepEqual(parseEditValue('cap', '21,5 t'), { capacityT: 21.5 });
  assert.equal(parseEditValue('cap', '0'), null);
  assert.equal(parseEditValue('cap', '150'), null);
  assert.deepEqual(parseEditValue('avail', '20.10', new Date('2026-10-12T10:00:00Z')), { availableFrom: '2026-10-20' });
  assert.deepEqual(parseEditValue('availto', '-'), { availableTo: null });
  assert.deepEqual(parseEditValue('minrate', '1 800'), { minRateUsd: 1800 });
  assert.deepEqual(parseEditValue('minrate', 'kelishiladi'), { minRateUsd: null });
  assert.deepEqual(parseEditValue('tdest', 'Moskva'), { destPref: 'Moskva' });
  assert.deepEqual(parseEditValue('tdest', '-'), { destPref: '' });
  assert.deepEqual(parseEditValue('plate', '01 A 123 BC'), { plate: '01 A 123 BC' });
  assert.equal(parseEditValue('plate', 'x'.repeat(30)), null);
  assert.deepEqual(parseEditValue('driverphone', '90 111 22 33'), { driverPhone: '+998901112233' });
});

test('the saved truck card shows everything to its owner; a draft shows warnings', () => {
  const card = formatMyTruck(SAVED, 'uz');
  assert.match(card, /Mening mashinam/);
  assert.match(card, /⚖️ 20 t · 82 m³/);
  assert.match(card, /TIR · GPS/);
  assert.match(card, /📍 Samarkand, UZ/);
  assert.match(card, /🔢 01 A 123 BC/);
  assert.match(card, /🧑‍✈️ Aziz/);
  const draft = formatTruckDraft({ locCityId: null, locCity: null, locText: 'Samrkand', destPref: 'Anywhere', equip: 'T', capacityT: 20, availableFrom: '2026-10-14', flags: ['location'] }, 1, 'uz');
  assert.match(draft, /🚫 Samrkand/);
  assert.match(draft, /joy aniqlanmadi/);
});

test('post a truck with the saved one: only the place, the date and the destination are asked', async () => {
  const { say, press, last, calls, buttons } = setup({ myTruck: SAVED });
  await say('🚚 Mashina joylash');
  assert.deepEqual(buttons(last()), ['ptr:go:saved', 'ptr:go:new', 'ptr:ai']);
  await press('ptr:go:saved');
  assert.match(last().text, /qayerda/i, 'asks where the truck is');
  assert.ok(buttons(last()).includes('ptr:loc:keep'), 'the usual place is one tap');
  await press('ptr:loc:keep');
  assert.deepEqual(buttons(last()).slice(0, 2), ['ptr:date:0', 'ptr:date:1']);
  await press('ptr:date:1');
  assert.ok(buttons(last()).includes('ptr:dest:any'));
  await press('ptr:dest:any');
  assert.match(last().text, /Samarkand, UZ/);
  assert.match(last().text, /Tekshiring/);
  assert.deepEqual(buttons(last()), ['ptr:ok', 'ptr:cancel']);
  await press('ptr:ok');
  const [, body] = calls.find((c) => c[0] === 'createTruck');
  assert.equal(body.equip, 'R'); assert.equal(body.capacityT, 20); assert.equal(body.volumeM3, 82); assert.equal(body.hasTir, true);
  assert.equal(body.locCityId, 88); assert.equal(body.destPref, 'Anywhere');
  assert.equal(body.contactPhone, '+998938747080'); assert.equal(body.contactTelegram, '@bek_disp');
  assert.match(body.availableFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(buttons(last()), ['ed:menu:T900', 'mytr:renew:900', 'mytr:ask:900'], 'no "save" offer: the truck is already the saved one');
  assert.doesNotMatch(last().text, /01 A 123 BC|Aziz/, 'plates and driver are never published');
});

test('post a truck step by step from nothing, then save it as my truck', async () => {
  const { say, press, last, calls, buttons, state } = setup();
  await say('/posttruck');
  assert.deepEqual(buttons(last()), ['ptr:go:new', 'ptr:ai']);
  await press('ptr:go:new');
  assert.ok(buttons(last()).includes('ptr:eq:T'));
  await press('ptr:eq:F');
  assert.match(last().text, /tonnada/);
  await say('abc');
  assert.match(last().text, /Bekor qilish|format|notoʻgʻri|Nom/i, 'a wrong capacity is refused and asked again');
  await say('22');
  await say('samarkand');
  assert.deepEqual(buttons(last()), ['ptr:city:88', 'ptr:city:89']);
  await press('ptr:city:88');
  await say('25.10'); // the date, typed
  await say('Moskva');
  assert.match(last().text, /Moskva/);
  await press('ptr:ok');
  const [, body] = calls.find((c) => c[0] === 'createTruck');
  assert.equal(body.equip, 'F'); assert.equal(body.capacityT, 22); assert.equal(body.destPref, 'Moskva'); assert.equal(body.locCityId, 88);
  assert.deepEqual(buttons(last()), ['ed:menu:T900', 'mytr:renew:900', 'mytr:ask:900', 'ptr:save:900'], 'offers to keep it as the default');
  await press('ptr:save:900');
  const [, put] = calls.find((c) => c[0] === 'putMyTruck');
  assert.equal(put.equip, 'F'); assert.equal(put.capacityT, 22); assert.equal(put.locCityId, 88);
  assert.equal(state.myTruck.equip, 'F');
});

test('AI: describe the trucks, check them, drop one, publish the rest', async () => {
  const { say, press, last, msgs, calls, buttons } = setup({ myTruck: SAVED });
  await say('/posttruck');
  await press('ptr:ai');
  assert.match(last().text, /forward/i);
  await say('Samarkand, tent 20t, Moskvaga, 1800$ +998901112233');
  assert.equal(calls.filter((c) => c[0] === 'parse').length, 1);
  const review = msgs().at(-1);
  assert.match(review.text, /#1/); assert.match(review.text, /#2/);
  assert.match(review.text, /Samarkand, UZ.*→ Moscow/s);
  assert.doesNotMatch(review.text, /🚫/, 'the second truck had no place in the post: the saved truck\'s place is used');
  const rid = buttons(review).find((b) => b.startsWith('trp:ok:')).split(':')[2];
  assert.deepEqual(buttons(review).filter((b) => b.startsWith('trp:rm')), [`trp:rm:${rid}:0`, `trp:rm:${rid}:1`]);
  await press(`trp:rm:${rid}:1`);
  await press(`trp:ok:${rid}`);
  const [, bodies] = calls.find((c) => c[0] === 'bulk');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].equip, 'T'); assert.equal(bodies[0].minRateUsd, 1800); assert.equal(bodies[0].contactPhone, '+998901112233');
  const card = msgs().find((m) => /Moscow/.test(m.text) && buttons(m).includes('mytr:renew:950'));
  assert.ok(card, 'each published truck follows as its own message with Edit / Renew / Delete');
});

test('AI: a truck whose place cannot be found and has no saved place cannot be published', async () => {
  const { say, press, msgs, buttons } = setup({ parse: async () => ({ truncated: false, trucks: [{ locCityId: null, locCity: null, locText: 'somewhere', destPref: 'Anywhere', equip: 'T', capacityT: 22, volumeM3: null, availableFrom: '2026-10-14', availableTo: null, minRateUsd: null, hasTir: false, hasAdr: false, hasGps: false, sideLoading: false, notes: '', contactPhone: '', contactTelegram: '', flags: ['location'] }] }) });
  await say('/posttruck'); await press('ptr:ai');
  await say('truck 22t somewhere free tomorrow');
  const review = msgs().at(-1);
  assert.match(review.text, /🚫/);
  assert.ok(!buttons(review).some((b) => b.startsWith('trp:ok:')), 'nothing to publish');
});

test('my trucks: cards with Edit / Renew / Delete; edit a field; delete asks first', async () => {
  const { say, press, msgs, calls, buttons, state } = setup({ trucks: [{ id: 5, locCityId: 88, locCity: 'Samarkand, UZ', destPref: 'Moscow', equip: 'T', capacityT: 22, volumeM3: null, availableFrom: '2026-10-14', availableTo: null, minRateUsd: null, hasTir: true, hasAdr: false, hasGps: false, sideLoading: false, notes: '', company: 'Bek', contactPhone: '+998938747080', contactTelegram: '' }] });
  await say('🚛 Mening mashinalarim');
  const card = msgs().find((m) => buttons(m).includes('ed:menu:T5'));
  assert.ok(card);
  assert.deepEqual(buttons(card), ['ed:menu:T5', 'mytr:renew:5', 'mytr:ask:5']);
  assert.match(card.text, /Samarkand, UZ/);
  await press('ed:f:T5:cap');
  await say('18');
  assert.deepEqual(calls.find((c) => c[0] === 'updateTruck'), ['updateTruck', 5, { capacityT: 18 }]);
  await press('ed:f:T5:tir');
  await press('ed:set:T5:tir:0');
  assert.deepEqual(calls.filter((c) => c[0] === 'updateTruck').at(-1), ['updateTruck', 5, { hasTir: false }]);
  await press('mytr:renew:5');
  assert.ok(calls.some((c) => c[0] === 'renewTruck'));
  await press('mytr:ask:5');
  assert.equal(state.trucks.length, 1, 'nothing is deleted until the person says yes');
  await press('mytr:del:5');
  assert.equal(state.trucks.length, 0);
});

test('my truck profile: add it (type + capacity), complete it with Edit, remove it', async () => {
  const { say, press, last, calls, buttons, state } = setup();
  await say('🛠 Mashina profili');
  assert.deepEqual(buttons(last()), ['mt:new']);
  await press('mt:new');
  await press('mt:eq:R');
  await say('20');
  assert.deepEqual(calls.find((c) => c[0] === 'putMyTruck'), ['putMyTruck', { equip: 'R', capacityT: 20 }]);
  assert.deepEqual(buttons(last()), ['ed:menu:M', 'mt:loads', 'mt:post', 'mt:ask']);
  await press('ed:f:M:plate');
  await say('01 A 123 BC');
  const put = calls.filter((c) => c[0] === 'putMyTruck').at(-1)[1];
  assert.equal(put.plate, '01 A 123 BC'); assert.equal(put.equip, 'R'); assert.ok(!('locCity' in put), 'the label is the server\'s to add');
  await press('ed:f:M:loc');
  await say('samarkand');
  await press('ed:city:88');
  assert.equal(calls.filter((c) => c[0] === 'putMyTruck').at(-1)[1].locCityId, 88);
  await press('ed:set:M:gps:1');
  assert.equal(calls.filter((c) => c[0] === 'putMyTruck').at(-1)[1].hasGps, true);
  await press('mt:ask');
  assert.ok(state.myTruck);
  await press('mt:del');
  assert.equal(state.myTruck, null);
});

test('near loads use the saved truck by default (type + capacity), with a switch; "loads for my truck" works without a shared position', async () => {
  const { say, press, location, calls } = setup({ myTruck: SAVED });
  await say('📍 Yaqin yuklar');
  await location(41.3, 69.2);
  const search = calls.filter((c) => c[0] === 'searchLoads').at(-1)[1];
  assert.equal(search.equip, 'R'); assert.equal(search.maxWeight, 20); assert.equal(search.nearLat, 41.3);
  await press('near:truck');
  assert.equal(calls.filter((c) => c[0] === 'searchLoads').at(-1)[1].equip, undefined, 'switched off: every load');
  await press('near:truck');
  assert.equal(calls.filter((c) => c[0] === 'searchLoads').at(-1)[1].equip, 'R');
});

test('"loads for my truck" with no shared position searches around where the truck stands', async () => {
  const { press, say, calls } = setup({ myTruck: SAVED });
  await say('/mytruck');
  await press('mt:loads');
  const p = calls.filter((c) => c[0] === 'searchLoads').at(-1)[1];
  assert.equal(p.origin, 88); assert.equal(p.equip, 'R'); assert.equal(p.maxWeight, 20); assert.equal(p.nearLat, undefined);
});

test('a truck posted anywhere reaches every group as its own message (and can be switched off)', async () => {
  const row = { id: 9, status: 'active', owner_id: 1, loc_city: 'Samarkand, UZ', dest_pref: 'Anywhere', equip: 'T', capacity_t: '22.00', volume_m3: null, available_from: '2026-10-14', available_to: null, min_rate_usd: null, has_tir: true, has_adr: false, has_gps: false, side_loading: false, notes: '', company_name: 'Bek', contact_phone: '+998938747080', contact_tg: '' };
  const run = async (broadcastTrucks) => {
    const sent = [];
    const b = makeBroadcaster({
      config: { databaseUrl: 'x', broadcastLang: 'uz', webBaseUrl: 'https://x', broadcastTrucks },
      pool: { query: async (sql) => ({ rows: sql.includes('FROM trucks') ? [row] : [] }) },
      store: { listActiveChatIds: async () => [111, 222], markChatRemoved: async () => {}, markBroadcasts: async () => { throw new Error('trucks are not tracked'); } },
      bot: { telegram: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: 1 }; } } }, log: { warn() {}, error() {} },
    });
    await b._handleEvent({ entity: 'trucks', op: 'insert', id: 9 });
    return sent;
  };
  const on = await run(true);
  assert.deepEqual(on.map((s) => s.chatId), [111, 222]);
  assert.match(on[0].text, /Samarkand, UZ/); assert.match(on[0].text, /22 t/);
  assert.deepEqual(await run(false), []);
});

test('«Clear from chat» deletes in bulk (100 per call) and falls back to one by one when Telegram refuses the bulk call', async () => {
  const { makeChatCleaner } = await import('../src/chatCleaner.js');
  const run = async (bulkWorks) => {
    const calls = []; const edits = [];
    const cleaner = makeChatCleaner({ store: { listSentMessages: async () => [], deleteSentMessages: async () => {} }, sleep: async () => {}, gapMs: 0 });
    const token = cleaner.register({ userId: 1, chatId: 5, msgIds: Array.from({ length: 230 }, (_, i) => i + 1) });
    const ctx = {
      from: { id: 1 }, lang: 'uz', callbackQuery: { message: { message_id: 999 } }, answerCbQuery: async () => {}, editMessageText: async (x) => { edits.push(x); },
      telegram: {
        deleteMessages: async (chat, ids) => { if (!bulkWorks) throw new Error('nope'); calls.push(['bulk', ids.length]); },
        deleteMessage: async () => { calls.push(['one']); },
      },
    };
    await cleaner.clear(ctx, token);
    return calls;
  };
  assert.deepEqual(await run(true), [['bulk', 100], ['bulk', 100], ['bulk', 30]]);
  assert.equal((await run(false)).filter((c) => c[0] === 'one').length, 230);
});
