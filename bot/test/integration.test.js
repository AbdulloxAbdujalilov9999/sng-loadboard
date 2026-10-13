// The bot against the REAL pieces it talks to: the real API (HTTP), the real PostgreSQL, and the real
// LISTEN/NOTIFY event channel. Only Telegram itself is faked (a recording `sendMessage`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, tokenFor, validLoad } from '../../server/test/helpers.js';
import { createHeuristicParser } from '../../server/src/lib/ai/heuristic.js';
import { makeApiClient, ApiError } from '../src/apiClient.js';
import { makeBroadcaster } from '../src/broadcaster.js';

let env; let base; let api; let cityA; let cityB;
before(async () => {
  env = await startTestEnv({}, { ai: createHeuristicParser() });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${env.app.server.address().port}`;
  api = makeApiClient({ baseUrl: base });
  await env.approvedMember('poster@test.com', 'Poster Co');
  await env.approvedMember('viewer@test.com', 'Viewer Co');
  cityA = await env.cityId('Tomsk, RU'); cityB = await env.cityId('Tashkent, UZ');
});
after(async () => { await env.close(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(40); } return false; }

/** A broadcaster wired to the real database + event channel, sending into an in-memory "Telegram". */
async function startBroadcaster({ chats = [111], failWith } = {}) {
  const sent = []; const removed = [];
  const bot = { telegram: { sendMessage: async (chatId, text) => { const e = failWith?.(chatId, sent.length); if (e) throw e; sent.push({ chatId, text }); } } };
  const store = {
    listActiveChatIds: async () => chats, markChatRemoved: async (id) => removed.push(id),
    getTelegramUserIdByMemberId: async () => null, saveSentMessage: async () => {},
    listSentMessages: async () => [], deleteSentMessages: async () => {},
  };
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: env.config.databaseUrl, broadcastSpacingMs: 0, broadcastLang: 'en', webBaseUrl: 'https://sng.example', webUrlIsPublic: true },
    pool: env.pool, store, bot, log: { warn() {}, error() {} }, sleep: async () => {},
  });
  await broadcaster.start();
  return { broadcaster, sent, removed };
}

test('/postload path: the bot posts through the real API with a member token, and the API accepts it', async () => {
  const token = tokenFor('poster@test.com');
  const me = await api.getMe(token);
  assert.equal(me.profile.status, 'approved');
  const { items } = await api.searchCities(token, 'tomsk');
  assert.ok(items.some((c) => c.label === 'Tomsk, RU'), 'the wizard can look cities up');

  // exactly the payload bot/src/wizard.js builds
  const created = await api.createLoad(token, {
    originCityId: cityA, destCityId: cityB, equip: 'T', fp: 'Full', weightT: 20, pickupDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    rateUsd: 0, commodity: 'ДСП МДФ', notes: 'ОПЛАТА НАХТ', contactName: 'Bek', contactPhone: '+998901234567', contactEmail: 'poster@test.com', contactTelegram: '@bek_disp',
  });
  assert.equal(created.company, 'Poster Co');
  assert.equal(created.rateUsd, 0, 'a negotiable (0) rate is accepted, as on the web');
  assert.equal((await env.as('viewer@test.com').get(`/api/loads/${created.id}`)).json.id, created.id, 'the deep link the bot sends resolves');
});

test('API rules reach the bot as ApiError: not signed in, not approved, bad data', async () => {
  await assert.rejects(api.getMe('garbage'), (e) => e instanceof ApiError && e.status === 401);
  await assert.rejects(api.createLoad(tokenFor('stranger@test.com'), {}), (e) => e instanceof ApiError && e.status === 403);
  const err = await api.createLoad(tokenFor('poster@test.com'), { originCityId: cityA, destCityId: cityA, equip: 'T', fp: 'Full', weightT: 20, pickupDate: '2099-01-01', rateUsd: 1, commodity: 'x', contactName: 'a', contactPhone: '+998901234567', contactEmail: 'poster@test.com', contactTelegram: '@bek_disp' }).catch((e) => e);
  assert.ok(err instanceof ApiError && err.status === 400 && err.details?.length, 'validation details are passed through');
});

test('a load posted on the WEB reaches every group, through the real NOTIFY channel, with notes and a deep link', async () => {
  const { broadcaster, sent } = await startBroadcaster({ chats: [111, 222] });
  try {
    const posted = await env.as('poster@test.com').post('/api/loads', { ...validLoad(cityA, cityB), notes: 'ОПЛАТА НАХТ · АВАНС БОР', commodity: 'ДСП <МДФ>' });
    assert.equal(posted.status, 201);
    assert.ok(await waitFor(() => sent.length === 2), `both groups got it, got ${sent.length}`);
    const text = sent[0].text;
    assert.match(text, /Tomsk, RU → Tashkent, UZ/);
    assert.match(text, /• ОПЛАТА НАХТ\n• АВАНС БОР/, 'the notes field travels with the load, one fact per line');
    assert.match(text, /ДСП &lt;МДФ&gt;/, 'user text is HTML-escaped for Telegram');
    assert.ok(text.includes(`https://sng.example/?load=${posted.json.id}`));
    assert.deepEqual(sent.map((s) => s.chatId).sort(), [111, 222]);
  } finally { await broadcaster.stop(); }
});

test('an AI-import batch of loads is broadcast one message per load, none lost, even when Telegram throttles (429)', async () => {
  let throttled = 0;
  const { broadcaster, sent } = await startBroadcaster({
    failWith: (chatId, n) => { if (n === 1 && throttled === 0) { throttled += 1; const e = new Error('Too Many Requests'); e.response = { error_code: 429, parameters: { retry_after: 1 } }; return e; } return null; },
  });
  try {
    const before = sent.length;
    const batch = Array.from({ length: 5 }, (_, i) => ({ ...validLoad(cityA, cityB), commodity: `Batch ${i}` }));
    const res = await env.as('poster@test.com').post('/api/loads/bulk', { loads: batch });
    assert.equal(res.status, 201);
    assert.ok(await waitFor(() => sent.length - before === 5, 10000), `5 messages expected, got ${sent.length - before}`);
    assert.equal(throttled, 1, 'the 429 really happened and was retried');
    const commodities = sent.slice(before).map((s) => /Batch (\d)/.exec(s.text)?.[1]).sort();
    assert.deepEqual(commodities, ['0', '1', '2', '3', '4']);
  } finally { await broadcaster.stop(); }
});

test('a closed or edited load is not re-broadcast; only new inserts are', async () => {
  const { broadcaster, sent } = await startBroadcaster();
  try {
    const posted = (await env.as('poster@test.com').post('/api/loads', { ...validLoad(cityA, cityB), commodity: 'Once only' })).json;
    assert.ok(await waitFor(() => sent.length === 1));
    await env.as('poster@test.com').patch(`/api/loads/${posted.id}`, { rateUsd: 999 });
    await env.as('poster@test.com').del(`/api/loads/${posted.id}`);
    await sleep(600);
    assert.equal(sent.length, 1, 'edits and removals do not spam the groups');
  } finally { await broadcaster.stop(); }
});

test('the per-member write budget is not shared between bot users (they all come from one address)', async () => {
  const limited = await startTestEnv({ WRITE_RATE_LIMIT_PER_MIN: '3' });
  try {
    await limited.approvedMember('a@test.com'); await limited.approvedMember('b@test.com');
    const [A, B] = [await limited.cityId('Tomsk, RU'), await limited.cityId('Tashkent, UZ')];
    const post = (who) => limited.as(who).post('/api/loads', validLoad(A, B));
    for (let i = 0; i < 3; i++) assert.equal((await post('a@test.com')).status, 201);
    assert.equal((await post('a@test.com')).status, 429, 'a hits ITS limit');
    for (let i = 0; i < 3; i++) assert.equal((await post('b@test.com')).status, 201, 'b is unaffected by a');
  } finally { await limited.close(); }
});

test('AI paste in the main bot: paste a freight post -> review -> one tap posts it through the real API', async () => {
  const { makePasteFlow } = await import('../src/pasteFlow.js');
  const { NotLinkedError } = await import('../src/tokens.js');
  const sent = []; const edits = [];
  const ctxFor = (text, linked = true) => ({
    from: { id: 4242 }, lang: 'en', chat: { id: 4242, type: 'private' }, message: { text },
    reply: async (msg, extra) => { sent.push({ msg, extra }); return { message_id: sent.length }; },
    editMessageText: async (msg) => { edits.push(msg); },
    answerCbQuery: async () => {},
    telegram: { editMessageText: async (_c, _m, _i, msg) => { edits.push(msg); } },
    _linked: linked,
  });
  const tokens = { getIdToken: async () => tokenFor('poster@test.com') };
  const flow = makePasteFlow({ apiClient: api, tokens, config: { aiMaxPerMin: 600, pendingTtlMin: 15, webBaseUrl: 'https://sng.example', webUrlIsPublic: true } });

  // not linked -> told to /link, nothing parsed
  const unlinked = makePasteFlow({ apiClient: api, tokens: { getIdToken: async () => { throw new NotLinkedError(); } }, config: { aiMaxPerMin: 600, pendingTtlMin: 15 } });
  const c0 = ctxFor('ТОМСК ТОШКЕНТ ДСП МДФ ТЕНТ 20т');
  await unlinked.handleText(c0);
  assert.match(sent.at(-1).msg, /My account/);

  // linked: parse, review, confirm
  const before = (await env.pool.query("SELECT count(*)::int AS n FROM loads WHERE status = 'active'")).rows[0].n;
  const ctx = ctxFor('🇷🇺ТОМСК \n🇺🇿ТОШКЕНТ \nДСП МДФ \nТЕНТ ФУРА \nОПЛАТА НАХТ \n+998918887695');
  await flow.handleText(ctx);
  const review = sent.at(-1);
  assert.ok(review.extra?.reply_markup, `no review keyboard: ${JSON.stringify([sent.map((x) => x.msg), edits])}`);
  const confirmData = review.extra.reply_markup.inline_keyboard[0][0].callback_data;
  assert.match(confirmData, /^paste:confirm:/);
  const draftMsg = sent.find((s) => /Tomsk, RU → Tashkent, UZ/.test(s.msg));
  assert.ok(draftMsg, 'the draft is shown for review');
  assert.deepEqual(draftMsg.extra.reply_markup.inline_keyboard[0].map((b) => b.callback_data.split(':')[0] + ':' + b.callback_data.split(':')[1]), ['ed:menu', 'pd:rm'], 'each load has its own Edit and Remove buttons');
  assert.equal((await env.pool.query("SELECT count(*)::int AS n FROM loads WHERE status = 'active'")).rows[0].n, before, 'nothing is posted before the tap');

  const nonce = confirmData.split(':')[2];
  await flow.handleConfirm(ctx, nonce);
  // the pasted post carries somebody else's phone number: the bot asks whose contact the load shows BEFORE publishing
  const question = sent.at(-1);
  assert.match(question.msg, /someone else's contact[\s\S]*\+998918887695/);
  assert.deepEqual(question.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), [`paste:contact:${nonce}:mine`, `paste:contact:${nonce}:keep`, `paste:contact:${nonce}:back`]);
  assert.equal((await env.pool.query("SELECT count(*)::int AS n FROM loads WHERE status = 'active'")).rows[0].n, before, 'still nothing posted');
  await flow.handleContactChoice(ctx, nonce, 'keep');
  assert.equal((await env.pool.query("SELECT contact_phone FROM loads WHERE commodity LIKE '%МДФ%' ORDER BY id DESC LIMIT 1")).rows[0].contact_phone, '+998918887695', 'the post\'s own contact is on the load');
  assert.match(edits.at(-1), /1 load\(s\) posted/);
  assert.doesNotMatch(edits.at(-1), /→/, 'the confirmation is a short summary, not a list of loads');
  assert.equal((await env.pool.query("SELECT count(*)::int AS n FROM loads WHERE status = 'active'")).rows[0].n, before + 1);
  await flow.handleConfirm(ctx, nonce); // a second tap on the same button posts nothing more
  assert.match(edits.at(-1), /expired/i);
  assert.equal((await env.pool.query("SELECT count(*)::int AS n FROM loads WHERE status = 'active'")).rows[0].n, before + 1);

  // never reads group chatter
  const group = ctxFor('ТОМСК ТОШКЕНТ ДСП МДФ ТЕНТ 20т'); group.chat.type = 'supergroup';
  const n = sent.length; await flow.handleText(group);
  assert.equal(sent.length, n);
});

test('/myloads edit + renew go through the real API: only the owner, only valid values', async () => {
  const token = tokenFor('poster@test.com');
  const made = await api.createLoad(token, {
    originCityId: cityA, destCityId: cityB, equip: 'T', fp: 'Full', weightT: 20, pickupDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    rateUsd: 0, commodity: 'Mebel', notes: '', contactName: 'Bek', contactPhone: '+998901234567', contactEmail: '', contactTelegram: '',
  });
  const edited = await api.updateLoad(token, made.id, { rateUsd: 1800, weightT: 21.5, notes: 'Avans bor' });
  assert.equal(edited.rateUsd, 1800);
  assert.equal(edited.weightT, 21.5);
  assert.equal(edited.notes, 'Avans bor');
  assert.equal(edited.commodity, 'Mebel', 'fields that were not sent stay as they are');
  await assert.rejects(api.updateLoad(token, made.id, { weightT: 500 }), (e) => e instanceof ApiError && e.status === 400);
  await assert.rejects(api.updateLoad(tokenFor('viewer@test.com'), made.id, { rateUsd: 1 }), (e) => e instanceof ApiError && e.status === 403, 'not your load');
  const renewed = await api.renewLoad(token, made.id);
  assert.equal(renewed.id, made.id);
  await api.deleteLoad(token, made.id);
  await assert.rejects(api.renewLoad(token, made.id), (e) => e instanceof ApiError && e.status === 404);
});

test('the copy of a load the poster gets in their own chat carries Edit / Renew / Delete; group copies stay plain', async () => {
  const sent = [];
  const bot = { telegram: { sendMessage: async (chatId, text, extra) => { sent.push({ chatId, text, extra }); return { message_id: sent.length }; } } };
  const store = {
    listActiveChatIds: async () => [111], markChatRemoved: async () => {}, getTelegramUserIdByMemberId: async () => 999,
    saveSentMessage: async () => {}, listSentMessages: async () => [], deleteSentMessages: async () => {}, getLanguage: async () => 'uz',
  };
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: env.config.databaseUrl, broadcastSpacingMs: 0, broadcastLang: 'uz', webBaseUrl: 'https://sng.example', webUrlIsPublic: true },
    pool: env.pool, store, bot, log: { warn() {}, error() {} }, sleep: async () => {},
  });
  await broadcaster.start();
  try {
    const posted = await env.as('poster@test.com').post('/api/loads', validLoad(cityA, cityB));
    assert.ok(await waitFor(() => sent.length === 2));
    const group = sent.find((s) => s.chatId === 111);
    const own = sent.find((s) => s.chatId === 999);
    assert.equal(group.extra.reply_markup, undefined, 'nobody else gets buttons');
    const data = own.extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(data, [`ed:menu:L${posted.json.id}`, `myloads:renew:${posted.json.id}`, `myloads:ask:${posted.json.id}`]);
    assert.match(own.extra.reply_markup.inline_keyboard[0][0].text, /Tahrirlash/);
  } finally { await broadcaster.stop(); }
});

test('50 loads posted at once all reach every group and the poster - each as its own message, at Telegram-safe pace', async () => {
  const sent = []; const waits = [];
  const bot = { telegram: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; } } };
  const store = {
    listActiveChatIds: async () => [111, 222], markChatRemoved: async () => {}, getTelegramUserIdByMemberId: async () => 999,
    saveSentMessage: async () => {}, listSentMessages: async () => [], deleteSentMessages: async () => {}, getLanguage: async () => 'uz',
  };
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: env.config.databaseUrl, broadcastSpacingMs: 0, broadcastGroupGapMs: 3100, broadcastOwnerGapMs: 1100, broadcastLang: 'uz', webBaseUrl: 'https://sng.example', webUrlIsPublic: true },
    pool: env.pool, store, bot, log: { warn() {}, error() {} }, sleep: async (ms) => { waits.push(ms); await new Promise((r) => setTimeout(r, 5)); },
  });
  await broadcaster.start();
  try {
    const loads = Array.from({ length: 50 }, (_, i) => ({ ...validLoad(cityA, cityB), commodity: `Paced ${i}` }));
    const res = await env.as('poster@test.com').post('/api/loads/bulk', { loads });
    assert.equal(res.status, 201);
    assert.ok(await waitFor(() => sent.filter((s) => s.chatId === 999).length === 50 && [111, 222].every((c) => sent.filter((s) => s.chatId === c).map((s) => s.text).join('').includes('Paced 49')), 20000), `got ${sent.length} messages`);
    for (const chat of [111, 222]) {
      const mine = sent.filter((s) => s.chatId === chat);
      const all = mine.map((s) => s.text).join('\n');
      for (let i = 0; i < 50; i += 1) assert.ok(all.includes(`Paced ${i}`), `group ${chat} is missing load ${i}`);
      assert.equal(mine.length, 50, `group ${chat}: one message per load`);
      assert.ok(mine.every((m) => (m.text.match(/🚚/g) ?? []).length === 1), 'never two loads in one message');
      assert.ok(mine.every((m) => m.text.length <= 4096), 'no message is over Telegram\'s limit');
    }
    assert.equal(sent.filter((s) => s.chatId === 999).length, 50, 'the poster still gets one message per load (each has its own buttons)');
    assert.ok(waits.some((w) => w > 2500), 'groups are paced to about 20 a minute');
  } finally { await broadcaster.stop(); }
});

test('a load some group never received (restart, failed send) is sent by the catch-up - once', async () => {
  const { makeStore } = await import('../src/store.js');
  const { makeCrypto } = await import('../src/crypto.js');
  const store = makeStore(env.pool, makeCrypto(Buffer.alloc(32, 3).toString('base64')));
  await env.pool.query("INSERT INTO telegram_chats (chat_id, chat_type, title, created_at) VALUES (4242, 'supergroup', 'Test group', now() - interval '1 day') ON CONFLICT DO NOTHING");
  const posted = await env.as('poster@test.com').post('/api/loads', { ...validLoad(cityA, cityB), commodity: 'Catch me up' }); // no broadcaster is running: nobody sends it
  assert.equal(posted.status, 201);
  await env.pool.query("UPDATE loads SET created_at = now() - interval '5 minutes' WHERE id = $1", [posted.json.id]);

  let failNext = true; const got = [];
  const bot = { telegram: { sendMessage: async (chatId, text) => { if (failNext) { failNext = false; throw Object.assign(new Error('Bad Gateway'), { response: { error_code: 502 } }); } got.push({ chatId, text }); return { message_id: 1 }; } } };
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: env.config.databaseUrl, broadcastSpacingMs: 0, broadcastLang: 'uz', webBaseUrl: 'https://sng.example', webUrlIsPublic: true },
    pool: env.pool, store, bot, log: { warn() {}, error() {}, info() {} }, sleep: async () => {},
  });
  await broadcaster._catchUp();
  assert.ok(await waitFor(() => failNext === false, 3000), 'first attempt was made (and failed)');
  await sleep(150);
  assert.equal(got.length, 0);
  assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM telegram_broadcasts WHERE load_id = $1', [posted.json.id])).rows[0].n, 0, 'a failed send is not recorded as sent');
  await broadcaster._catchUp(); // the next minute\'s run
  assert.ok(await waitFor(() => got.some((g) => g.chatId === 4242 && /Catch me up/.test(g.text)), 3000), 'the group gets the load now');
  await sleep(150);
  await broadcaster._catchUp();
  await sleep(150);
  assert.equal(got.filter((g) => /Catch me up/.test(g.text)).length, 1, 'and only once');
  assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM telegram_broadcasts WHERE load_id = $1 AND chat_id = 4242', [posted.json.id])).rows[0].n, 1);
});

test('sign-up from the bot against the real API: account, Telegram link and a website link that signs in once', async () => {
  const phone = '+998901119900';
  await api.phoneRegister({ phone, pin: '4829', contactName: 'Bot Person', telegram: '' });
  await assert.rejects(api.phoneRegister({ phone, pin: '4829', contactName: 'Again', telegram: '' }), (e) => e instanceof ApiError && e.details?.some((d) => d.code === 'phone_taken'));
  assert.deepEqual(await api.phoneCheck(phone), { exists: true, hasPin: true });
  const session = await api.pinLogin(phone, '4829'); // what performLink does right after registering
  const { code } = await api.createLoginLink(session.token);
  const web = await env.anon().post('/api/auth/link-login', { code });
  assert.equal(web.status, 200);
  assert.equal((await env.withToken(web.json.token).get('/api/me')).json.profile.contactName, 'Bot Person', 'the website session is that member');
  assert.equal((await env.anon().post('/api/auth/link-login', { code })).status, 401, 'the code works once');
});

test('the saved position lives in the database: shared, radius remembered, deleted - and it never changes the person\'s language', async () => {
  const { makeStore } = await import('../src/store.js');
  const { makeCrypto } = await import('../src/crypto.js');
  const store = makeStore(env.pool, makeCrypto(Buffer.alloc(32, 5).toString('base64')));
  const id = 880011;
  assert.deepEqual(await store.getGeo(id), { lat: null, lng: null, at: null, miles: 100 }, 'nobody is on file by default');
  await store.setGeo(id, { lat: 41.3, lng: 69.2405, language: 'uz' });
  const g = await store.getGeo(id);
  assert.equal(g.lat, 41.3); assert.equal(g.lng, 69.2405); assert.ok(g.at);
  assert.equal(await store.getLanguage(id), 'uz', 'a row made by sharing a location carries the language the person is spoken to in');
  await store.setLanguage(id, 'ru');
  await store.setGeo(id, { lat: 40, lng: 70, language: 'uz' });
  assert.equal(await store.getLanguage(id), 'ru', 'sharing again never overwrites their language choice');
  await store.setGeoMiles(id, 200, 'ru');
  assert.equal((await store.getGeo(id)).miles, 200);
  await store.clearGeo(id);
  const gone = await store.getGeo(id);
  assert.deepEqual([gone.lat, gone.lng, gone.at, gone.miles], [null, null, null, 200], 'the position is gone, the radius preference stays');
  await assert.rejects(env.pool.query('UPDATE telegram_users SET geo_lat = 10 WHERE telegram_user_id = $1', [id]), /geo_valid/, 'a half position is refused by the database');
  await assert.rejects(env.pool.query('UPDATE telegram_users SET geo_miles = 5000 WHERE telegram_user_id = $1', [id]), /geo_valid/);
  // new member with no row yet: radius first, language is still theirs
  await store.setGeoMiles(880012, 50, 'en');
  assert.equal(await store.getLanguage(880012), 'en');
});

test('a load cleared from the chat before it arrived is never sent to that chat, but still goes to the groups', async () => {
  const sent = [];
  const bot = { telegram: { sendMessage: async (chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; } } };
  const store = {
    listActiveChatIds: async () => [111], markChatRemoved: async () => {}, getTelegramUserIdByMemberId: async () => 999,
    saveSentMessage: async () => {}, listSentMessages: async () => [], deleteSentMessages: async () => {}, getLanguage: async () => 'uz',
  };
  const hidden = new Set();
  const broadcaster = makeBroadcaster({
    config: { databaseUrl: env.config.databaseUrl, broadcastSpacingMs: 0, broadcastLang: 'uz', webBaseUrl: 'https://sng.example', webUrlIsPublic: true },
    pool: env.pool, store, bot, log: { warn() {}, error() {} }, sleep: async () => {}, suppressOwner: (id) => hidden.has(id),
  });
  await broadcaster.start();
  try {
    const first = await env.as('poster@test.com').post('/api/loads', { ...validLoad(cityA, cityB), commodity: 'Visible' });
    assert.ok(await waitFor(() => sent.filter((s) => s.chatId === 999).length === 1 && sent.filter((s) => s.chatId === 111).length === 1));
    // the person cleared their chat; the next load was still on its way
    const second = await env.as('poster@test.com').post('/api/loads', { ...validLoad(cityA, cityB), commodity: 'Cleared before arrival' });
    hidden.add(second.json.id);
    assert.ok(await waitFor(() => sent.filter((s) => s.chatId === 111 && /Cleared before arrival/.test(s.text)).length === 1), 'the group still gets it');
    await sleep(200);
    assert.equal(sent.filter((s) => s.chatId === 999 && /Cleared before arrival/.test(s.text)).length, 0, 'the cleared chat does not');
    assert.ok(first.json.id);
  } finally { await broadcaster.stop(); }
});

test('the bot\'s "near me" search against the real API: radius, nearest first, paging, trucks', async () => {
  const token = tokenFor('viewer@test.com');
  await env.as('poster@test.com').post('/api/loads', { ...validLoad(cityB, cityA), commodity: 'From Tashkent' }); // cityB = Tashkent
  const tashkent = { nearLat: 41.3, nearLng: 69.24 };
  const near = await api.searchLoads(token, { ...tashkent, originRadius: 161, sort: 'nearest', dir: 'asc', limit: 10 });
  assert.ok(near.items.every((l) => typeof l.dho === 'number' && l.dho <= 161), 'every result is inside 100 miles');
  assert.ok(near.items.some((l) => l.commodity === 'From Tashkent'), 'a load that starts in Tashkent is inside');
  assert.deepEqual(near.items.map((l) => l.dho), [...near.items.map((l) => l.dho)].sort((a, b) => a - b), 'nearest first');
  const tight = await api.searchLoads(token, { ...tashkent, originRadius: 1, limit: 10 });
  assert.ok(tight.items.every((l) => l.originCity.startsWith('Tashkent')));
  const empty = await api.searchLoads(token, { nearLat: -45, nearLng: 170, originRadius: 161, limit: 10 }); // the other side of the world
  assert.deepEqual(empty.items, []);
  const trucks = await api.searchTrucks(token, { ...tashkent, locRadius: 161, sort: 'nearest', dir: 'asc', limit: 10 });
  assert.ok(Array.isArray(trucks.items));
  await assert.rejects(api.searchLoads(token, { nearLat: 41.3 }), (e) => e instanceof ApiError && e.status === 400, 'half a position is refused');
});
