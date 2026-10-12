// The real Telegraf wiring (bot.js) driven with fake Telegram updates: what a person actually sees when they type /paste,
// paste a post, mistype a command, or write in a group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from 'telegraf';
import { makeBot } from '../src/bot.js';

// Telegraf builds a fresh Telegram client for every update, so the fake has to sit on the class itself.
const realCallApi = Telegram.prototype.callApi;
let record = () => {};
Telegram.prototype.callApi = async function fake(method, payload) { return record(method, payload); };
process.on('exit', () => { Telegram.prototype.callApi = realCallApi; });

function setup({ parseLoads } = {}) {
  const sent = [];
  const config = { botToken: '123:test', broadcastLang: 'uz', joinChannel: 'sngOne_yuklar', joinGroup: 'sngOne_yuklarr', aiMaxPerMin: 600, pendingTtlMin: 15, webBaseUrl: 'https://sng.example', webUrlIsPublic: true };
  const store = { getLanguage: async () => null, setLanguage: async () => {}, getLinkByTelegramUserId: async () => null, removeLink: async () => false };
  const tokens = { getIdToken: async () => 'tok', invalidate() {} };
  const apiClient = {
    getMe: async () => ({ profile: { id: 1, status: 'approved', company: 'Acme', phone: '+998901112233' } }),
    parseLoads: parseLoads ?? (async () => ({ loads: [] })),
  };
  const bot = makeBot({ config, firebaseAuth: {}, apiClient, tokens, store });
  bot.botInfo = { id: 123, is_bot: true, first_name: 'sng', username: 'sng_test_bot' };
  record = (method, payload) => { sent.push({ method, ...payload }); return { message_id: sent.length, chat: { id: payload.chat_id } }; };
  let n = 0;
  const say = (text, { type = 'private', code = 'uz' } = {}) => bot.handleUpdate({
    update_id: ++n,
    message: {
      message_id: n, date: 0, text, from: { id: 77, is_bot: false, first_name: 'Bek', language_code: code },
      chat: { id: type === 'private' ? 77 : -100, type },
      ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s/)[0].length }] } : {}),
    },
  });
  const texts = () => sent.filter((s) => s.method === 'sendMessage').map((s) => s.text);
  const edits = () => sent.filter((s) => s.method === 'editMessageText').map((s) => s.text);
  return { say, texts, edits, sent };
}

test('/paste answers with how-to, in Uzbek by default', async () => {
  const { say, texts } = setup();
  await say('/paste');
  assert.equal(texts().length, 1);
  assert.match(texts()[0], /Yuk postini shu yerga joylang/);
});

test('/paste <text> goes straight to the AI; a short text gets a hint instead of silence', async () => {
  let asked = null;
  const { say, texts, edits } = setup({ parseLoads: async (_t, text) => { asked = text; return { loads: [] }; } });
  await say('/paste ТОМСК ТОШКЕНТ ДСП МДФ ТЕНТ +998901112233');
  assert.match(asked, /^ТОМСК ТОШКЕНТ/);
  assert.ok(edits().some((x) => /yuk topa olmadim/.test(x)), 'told that no load was found');
  await say('salom');
  assert.match(texts().at(-1), /Yordam: \/paste/);
});

test('plain pasted text works without any command; groups are never read; unknown commands get an answer', async () => {
  let calls = 0;
  const { say, texts } = setup({ parseLoads: async () => { calls += 1; return { loads: [] }; } });
  await say('ТОМСК ТОШКЕНТ ДСП МДФ ТЕНТ +998901112233');
  assert.equal(calls, 1);
  const before = texts().length;
  await say('ТОМСК ТОШКЕНТ ДСП МДФ ТЕНТ +998901112233', { type: 'supergroup' });
  assert.equal(texts().length, before, 'silent in a group');
  assert.equal(calls, 1);
  await say('/nosuchcommand');
  assert.match(texts().at(-1), /Bunday buyruq yoʻq/);
});

test('every old command still answers; Russian phones get Russian', async () => {
  const { say, texts } = setup();
  await say('/start'); assert.match(texts().at(-1), /SNG ONE/);
  assert.match(texts().at(-1), /AI bilan joylash/);
  assert.match(texts().at(-1), /@sngOne_yuklar/, 'the channel and group are offered');
  await say('/mystatus'); assert.equal(texts().length, 2);
  await say('/language'); assert.equal(texts().length, 3);
  await say('/unlink'); assert.equal(texts().length, 4);
  await say('/link'); assert.ok(texts().length >= 5, '/link starts its dialogue');
  const ru = setup();
  await ru.say('/paste', { code: 'ru' });
  assert.match(ru.texts()[0], /Вставьте или перешлите/);
});
