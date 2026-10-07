// The bot against the REAL pieces it talks to: the real API (HTTP), the real PostgreSQL, and the real
// LISTEN/NOTIFY event channel. Only Telegram itself is faked (a recording `sendMessage`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, tokenFor, validLoad } from '../../server/test/helpers.js';
import { makeApiClient, ApiError } from '../src/apiClient.js';
import { makeBroadcaster } from '../src/broadcaster.js';

let env; let base; let api; let cityA; let cityB;
before(async () => {
  env = await startTestEnv();
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
  const store = { listActiveChatIds: async () => chats, markChatRemoved: async (id) => removed.push(id) };
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
    assert.match(text, /ОПЛАТА НАХТ · АВАНС БОР/, 'the notes field travels with the load');
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
