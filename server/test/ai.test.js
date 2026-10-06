import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { buildCityIndex, fold, resolveCity } from '../src/lib/ai/cities.js';
import { createHeuristicParser } from '../src/lib/ai/heuristic.js';
import { buildSystemPrompt, createGeminiParser } from '../src/lib/ai/gemini.js';

// The exact kind of text members paste (flags, Cyrillic, Uzbek slang, several loads at once).
const PASTE = `
🇷🇺ТОМСК АСИНО 
🇺🇿ТОШКЕНТ 
ДСП МДФ 
ТЕНТ РЕФ ФУРА 
ОПЛАТА НАХТ 
ПОГРУЗКА ТАЙЙОР 
АВАНС БОР 
+998918887695



🇷🇺МОСКВА ЭЛЕКТРОГОРСК   
🇺🇿ХОРАЗМ 
ДСП МДФ 
ТЕНТ ФУРА 
ОПЛАТА НАХТ 
ПОГРУЗКА ТАЙЙОР 
АВАНС БОР 
+998918887695



🇷🇺КАЛУГА БАЛАБАНОВА 
🇺🇿ТОШКЕНТ 
ДСП МДФ 
ТЕНТ ФУРА 
ОПЛАТА НАХТ 
ПОГРУЗКА ТАЙЙОР 
АВАНС БОР 
+998918887695



🇷🇺КАЛУГА ЛЮДИНОВО   
🇺🇿БУХОРО 
🇺🇿ХОРАЗМ 
ДСП МДФ 
ТЕНТ ФУРА 
ОПЛАТА НАХТ 
ПОГРУЗКА ТАЙЙОР 
АВАНС БОР 
+998918887695
`;

let env; let index;
before(async () => {
  env = await startTestEnv({}, { ai: createHeuristicParser() });
  await env.approvedMember('dispatcher@test.com', 'Dispatch Co');
  const { rows } = await env.pool.query('SELECT id, label, name, name_ru, country, lat, lng FROM cities ORDER BY id');
  index = buildCityIndex(rows);
});
after(async () => { await env.close(); });

test('city matching understands Russian, Uzbek-Latin, Uzbek-Cyrillic and English spellings', () => {
  const label = (text, extra = {}) => resolveCity(index, { text, ...extra }).city?.label ?? null;
  assert.equal(label('ТОШКЕНТ'), 'Tashkent, UZ');
  assert.equal(label('Toshkent'), 'Tashkent, UZ');
  assert.equal(label('Ташкент'), 'Tashkent, UZ');
  assert.equal(label('🇺🇿Tashkent'), 'Tashkent, UZ');
  assert.equal(label('МОСКВА'), 'Moscow, RU');
  assert.equal(label('Moskva'), 'Moscow, RU');
  assert.equal(label('Бухоро'), 'Bukhara, UZ');
  assert.equal(label('Buxoro'), 'Bukhara, UZ');
  assert.equal(label('Samarqand'), 'Samarkand, UZ');
  assert.equal(label('Самарқанд'), 'Samarkand, UZ');
  assert.equal(label('КАЛУГА БАЛАБАНОВА'), 'Kaluga, RU', 'main city + small town -> the main city');
  assert.equal(label('ТОМСК АСИНО'), 'Tomsk, RU');
  assert.equal(label('Асино'), null, 'a town that is not in the list never snaps onto an unrelated city');
  assert.equal(label('Хоразм'), 'Urgench, UZ', 'region -> main city');
  assert.equal(label('Xorazm viloyati'), 'Urgench, UZ');
  assert.equal(label('Қашқадарё'), 'Karshi, UZ');
  assert.equal(label('Atlantis'), null);
  assert.equal(label('???'), null);
  // the AI's own pick wins when it is a real label, and an invented label is ignored
  assert.equal(label('whatever', { label: 'Urgench, UZ' }), 'Urgench, UZ');
  assert.equal(label('Томск', { label: 'Narnia, XX' }), 'Tomsk, RU');
  assert.ok(fold('Тошкент') === fold('Toshkent'));
});

test('parse-loads: members only, validates the paste', async () => {
  assert.equal((await env.as('nobody@test.com').post('/api/ai/parse-loads', { text: PASTE })).status, 403);
  const api = env.as('dispatcher@test.com');
  assert.equal((await api.post('/api/ai/parse-loads', { text: '' })).status, 400);
  assert.equal((await api.post('/api/ai/parse-loads', { text: 'x'.repeat(13000) })).status, 400);
});

test('parse-loads: one draft per pasted load, with cities, cargo, equipment, notes and phone', async () => {
  const r = await env.as('dispatcher@test.com').post('/api/ai/parse-loads', { text: PASTE });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const d = r.json.loads;
  assert.equal(d.length, 4, 'four pasted blocks -> four drafts');

  assert.equal(d[0].originCity, 'Tomsk, RU');
  assert.equal(d[0].destCity, 'Tashkent, UZ');
  assert.equal(d[0].commodity, 'ДСП МДФ');
  assert.equal(d[0].equip, 'T');
  assert.match(d[0].notes, /ОПЛАТА НАХТ/);
  assert.match(d[0].notes, /АВАНС БОР/);
  assert.match(d[0].notes, /PU: ТОМСК АСИНО/, 'the small town is kept in the notes, not lost');
  assert.match(d[0].notes, /Also: R/, 'second accepted trailer type is kept');
  assert.equal(d[0].contactPhone, '+998918887695');
  assert.deepEqual(d[0].flags.sort(), ['date', 'rate', 'weight'], 'missing facts are flagged for the member to check');
  assert.equal(d[0].weightT, 20);
  assert.equal(d[0].pickupDate, new Date().toISOString().slice(0, 10));

  assert.equal(d[1].originCity, 'Moscow, RU');
  assert.equal(d[1].destCity, 'Urgench, UZ', 'Хоразм is a region -> its main city');
  assert.ok(!d[1].flags.includes('dest'));
  assert.equal(d[2].originCity, 'Kaluga, RU');
  assert.equal(d[2].destCity, 'Tashkent, UZ');
  assert.equal(d[3].destCity, 'Bukhara, UZ');
  assert.match(d[3].notes, /Also DEL: Urgench, UZ/, 'extra destinations are kept in the notes');
});

test('parse-loads: model output is verified, never trusted', async () => {
  const hostile = {
    name: 'fake',
    async parseLoads() {
      return { loads: [
        { origin: { place: 'Almaty', cityLabel: 'Almaty, KZ' }, destinations: [{ place: 'Tashkent', cityLabel: 'Tashkent, UZ' }], equipment: ['T', 'ROCKET', 'r'],
          fullOrPartial: 'Maybe', weightT: 9999, pickupDate: '2026-02-31', rateUsd: -5, commodity: 'x'.repeat(500), notes: 'n'.repeat(900), phone: '+998 90 123 45 67', telegram: null, contactName: null, evil: '<script>' },
        { origin: { place: 'Narnia', cityLabel: 'Narnia, XX' }, destinations: [], equipment: [], commodity: '', notes: '' },
      ] };
    },
  };
  const e2 = await startTestEnv({}, { ai: hostile });
  try {
    await e2.approvedMember('m@test.com', 'M Co');
    const r = await e2.as('m@test.com').post('/api/ai/parse-loads', { text: 'some pasted text here' });
    assert.equal(r.status, 200);
    const [a, b] = r.json.loads;
    assert.equal(a.originCity, 'Almaty, KZ');
    assert.equal(a.equip, 'T');
    assert.equal(a.fp, 'Full');
    assert.equal(a.weightT, 20, 'absurd weight replaced by the default and flagged');
    assert.equal(a.pickupDate, new Date().toISOString().slice(0, 10), 'impossible date replaced');
    assert.equal(a.rateUsd, 0);
    assert.ok(a.commodity.length <= 200 && a.notes.length <= 500);
    assert.equal(a.evil, undefined, 'unknown fields never reach the browser');
    assert.equal(b.originCityId, null);
    assert.ok(b.flags.includes('origin') && b.flags.includes('dest'));
    // and a draft that came out of this still has to pass the normal posting rules
    const bad = await e2.as('m@test.com').post('/api/loads', { ...validLoad(a.originCityId, a.destCityId), weightT: a.weightT, commodity: a.commodity, notes: a.notes });
    assert.equal(bad.status, 201);
  } finally { await e2.close(); }
});

test('parse-loads: AI not configured, provider failures and per-member budget', async () => {
  const off = await startTestEnv({}, { ai: null });
  try {
    await off.approvedMember('m@test.com');
    const r = await off.as('m@test.com').post('/api/ai/parse-loads', { text: 'some pasted text here' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'ai_unavailable');
    assert.equal((await off.as('m@test.com').get('/api/loads')).status, 200, 'rest of the app is unaffected');
  } finally { await off.close(); }

  const broken = await startTestEnv({ AI_RATE_PER_HOUR: '2' }, { ai: { name: 'broken', async parseLoads() { throw new Error('boom secret-key-123'); } } });
  try {
    await broken.approvedMember('m@test.com');
    const api = broken.as('m@test.com');
    const r = await api.post('/api/ai/parse-loads', { text: 'some pasted text here' });
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.json).includes('secret-key'), 'provider errors never leak to the browser');
    await api.post('/api/ai/parse-loads', { text: 'some pasted text here' });
    assert.equal((await api.post('/api/ai/parse-loads', { text: 'some pasted text here' })).status, 429, 'per-member hourly budget');
  } finally { await broken.close(); }
});

test('Gemini client: request shape, structured output, and error mapping', async () => {
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ loads: [] }) }] } }] }) };
  };
  const g = createGeminiParser({ apiKey: 'KEY', model: 'gemini-test', fetchImpl: fakeFetch });
  const out = await g.parseLoads({ text: 'hello', cities: index.cities, today: '2026-10-06' });
  assert.deepEqual(out, { loads: [] });
  assert.match(seen.url, /models\/gemini-test:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'KEY', 'key travels in a header, never in the URL');
  assert.ok(!seen.url.includes('KEY'));
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(seen.body.generationConfig.responseSchema);
  assert.equal(seen.body.generationConfig.temperature, 0);
  assert.equal(seen.body.contents[0].parts[0].text, 'hello', 'pasted text is sent as user data, not as instructions');
  assert.match(seen.body.systemInstruction.parts[0].text, /Tomsk, RU \(Томск\)/, 'city list is given to the model');
  assert.match(buildSystemPrompt({ cities: index.cities, today: '2026-10-06' }), /UNTRUSTED DATA/);

  const failing = (status, body = '') => createGeminiParser({ apiKey: 'K', fetchImpl: async () => ({ ok: false, status, text: async () => body }) });
  await assert.rejects(failing(429).parseLoads({ text: 'x', cities: [], today: '' }), (e) => e.code === 'ai_busy' && e.status === 503);
  await assert.rejects(failing(403, 'API key not valid: K').parseLoads({ text: 'x', cities: [], today: '' }), (e) => e.code === 'ai_failed' && !e.message.includes('K'));
  const garbage = createGeminiParser({ apiKey: 'K', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) }) });
  await assert.rejects(garbage.parseLoads({ text: 'x', cities: [], today: '' }), (e) => e.code === 'ai_bad_output');
});

test('bulk post: all-or-nothing, quotas counted for the whole batch, notes stored', async () => {
  const api = env.as('dispatcher@test.com');
  const A = await env.cityId('Tomsk, RU'); const B = await env.cityId('Tashkent, UZ');
  const good = { ...validLoad(A, B), notes: 'ОПЛАТА НАХТ · АВАНС БОР' };
  const r = await api.post('/api/loads/bulk', { loads: [good, { ...good, commodity: 'Second' }] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.items.length, 2);
  assert.equal(r.json.items[0].notes, 'ОПЛАТА НАХТ · АВАНС БОР');
  assert.equal(r.json.items[0].mine, true);
  const mine = (await api.get('/api/loads/mine')).json.items;
  assert.equal(mine.length, 2);
  assert.equal(mine[0].notes.length > 0, true);

  const before = (await api.get('/api/loads/mine')).json.items.length;
  const bad = await api.post('/api/loads/bulk', { loads: [good, { ...good, destCityId: A }, good] });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error.details.some((d) => d.path === 'loads.1.destCityId'), `error points at the row: ${JSON.stringify(bad.json.error.details)}`);
  assert.equal((await api.get('/api/loads/mine')).json.items.length, before, 'nothing was half-posted');

  assert.equal((await api.post('/api/loads/bulk', { loads: [] })).status, 400);
  assert.equal((await api.post('/api/loads/bulk', { loads: Array.from({ length: 41 }, () => good) })).status, 400);

  const capped = await startTestEnv({ MAX_ACTIVE_LOADS_PER_MEMBER: '3' });
  try {
    await capped.approvedMember('c@test.com');
    const c = capped.as('c@test.com');
    const x = { ...validLoad(A, B) };
    assert.equal((await c.post('/api/loads/bulk', { loads: [x, x] })).status, 201);
    assert.equal((await c.post('/api/loads/bulk', { loads: [x, x] })).status, 429, 'would exceed the limit as a whole');
    assert.equal((await c.get('/api/loads/mine')).json.items.length, 2);
  } finally { await capped.close(); }
});

test('notes survive edits that do not touch them; default contact e-mail is saved on the profile', async () => {
  const api = env.as('dispatcher@test.com');
  const A = await env.cityId('Tomsk, RU'); const B = await env.cityId('Tashkent, UZ');
  const created = (await api.post('/api/loads', { ...validLoad(A, B), notes: 'keep me' })).json;
  const patched = (await api.patch(`/api/loads/${created.id}`, { rateUsd: 1234 })).json;
  assert.equal(patched.notes, 'keep me');
  assert.equal((await api.patch(`/api/loads/${created.id}`, { notes: 'changed' })).json.notes, 'changed');

  const p = await api.patch('/api/me/profile', { contactEmail: 'Dispatch@Example.com' });
  assert.equal(p.status, 200);
  assert.equal((await api.get('/api/me')).json.profile.contactEmail, 'dispatch@example.com');
  assert.equal((await api.patch('/api/me/profile', { contactEmail: 'not-an-email' })).status, 400);
  assert.equal((await api.patch('/api/me/profile', { contactEmail: '' })).status, 200, 'can be cleared');
});

test('profile: contact fields can be saved one at a time and cleared; /api/config reports the AI mode', async () => {
  const fresh = await startTestEnv({}, { ai: createHeuristicParser() });
  try {
    await fresh.pool.query(`INSERT INTO members (email, company, contact_name, status, reviewed_at) VALUES ('new@test.com', 'New Co', '', 'approved', now())`);
    const api = fresh.as('new@test.com');
    // exactly what the Account form sends when only a phone number was typed
    const onlyPhone = await api.patch('/api/me/profile', { company: 'New Co', contactName: '', phone: '+998 90 123 45 67', telegram: '', contactEmail: '', location: '', tirCarnet: '', fleet: '', routes: '' });
    assert.equal(onlyPhone.status, 200, JSON.stringify(onlyPhone.json));
    assert.equal(onlyPhone.json.profile.phone, '+998 90 123 45 67');
    assert.equal((await api.patch('/api/me/profile', { telegram: 'ab' })).status, 400, 'a filled-in but invalid handle is still rejected');
    assert.equal((await api.patch('/api/me/profile', { phone: '' })).status, 200, 'and a field can be cleared');
    assert.equal((await api.patch('/api/me/profile', { company: '' })).status, 400, 'company stays required');
    assert.equal((await fresh.app.inject({ method: 'GET', url: '/api/config' })).json().aiImport, 'basic');
  } finally { await fresh.close(); }
  const off = await startTestEnv({}, { ai: null });
  try { assert.equal((await off.app.inject({ method: 'GET', url: '/api/config' })).json().aiImport, false); } finally { await off.close(); }
  const real = await startTestEnv({}, { ai: createGeminiParser({ apiKey: 'k' }) });
  try { assert.equal((await real.app.inject({ method: 'GET', url: '/api/config' })).json().aiImport, 'ai'); } finally { await real.close(); }
});
