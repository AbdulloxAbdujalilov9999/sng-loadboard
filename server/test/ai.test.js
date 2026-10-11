import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestEnv, validLoad } from './helpers.js';
import { buildCityIndex, fold, resolveCity, searchCities } from '../src/lib/ai/cities.js';
import { createHeuristicParser } from '../src/lib/ai/heuristic.js';
import { createGeminiParser, loadsPrompt, trucksPrompt } from '../src/lib/ai/gemini.js';

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
  const { rows } = await env.pool.query('SELECT id, label, name, name_ru, country, lat, lng, aliases, population FROM cities ORDER BY id');
  index = buildCityIndex(rows);
});
after(async () => { await env.close(); });

test('city matching: spellings, scripts, regions, towns, endings and typos all land on the right city', () => {
  const label = (text, extra = {}) => resolveCity(index, { text, ...extra }).city?.label ?? null;
  // big cities in every script
  for (const [text, want] of [
    ['ТОШКЕНТ', 'Tashkent, UZ'], ['Toshkent', 'Tashkent, UZ'], ['Ташкент', 'Tashkent, UZ'], ['🇺🇿Tashkent', 'Tashkent, UZ'],
    ['МОСКВА', 'Moscow, RU'], ['Moskva', 'Moscow, RU'], ['Бухоро', 'Bukhara, UZ'], ['Buxoro', 'Bukhara, UZ'], ['Samarqand', 'Samarkand, UZ'],
    ['Самарқанд', 'Samarkand, UZ'], ['Андижон', 'Andijan, UZ'], ['Farg‘ona', 'Fergana, UZ'], ['Qo‘qon', 'Kokand, UZ'], ['Termiz', 'Termez, UZ'],
    ['Urganch', 'Urgench, UZ'], ['Xiva', 'Khiva, UZ'], ['Qarshi', 'Karshi, UZ'], ['Санкт-Петербург', 'Saint Petersburg, RU'], ['СПб', 'Saint Petersburg, RU'],
    ['Алма-Ата', 'Almaty, KZ'], ['Нур-Султан', 'Astana, KZ'], ['Чимкент', 'Shymkent, KZ'],
  ]) assert.equal(label(text), want, text);

  // REGIONS people write instead of a city (the thing that used to find nothing)
  for (const text of ['Xorazm', 'Хоразм', 'ХОРАЗМ', 'Xorazm viloyati', 'Khorezm', 'Хорезмская область']) assert.equal(label(text), 'Urgench, UZ', text);
  assert.equal(label('Qashqadaryo'), 'Karshi, UZ');
  assert.equal(label('Surxondaryo viloyati'), 'Termez, UZ');
  assert.equal(label('Московская область'), 'Moscow, RU');
  assert.equal(label('Самаркандская область'), 'Samarkand, UZ');

  // SMALL TOWNS that used to be unknown, and "main city + town" lines -> the specific town
  assert.equal(label('Асино'), 'Asino, RU');
  assert.equal(label('ТОМСК АСИНО'), 'Asino, RU');
  assert.equal(label('МОСКВА ЭЛЕКТРОГОРСК'), 'Elektrogorsk, RU');
  assert.equal(label('КАЛУГА БАЛАБАНОВА'), 'Balabanovo, RU', 'Russian ending -а still finds Балабаново');
  assert.equal(label('КАЛУГА ЛЮДИНОВО'), 'Lyudinovo, RU');
  assert.equal(label('Томск'), 'Tomsk, RU', 'a lone big city is still itself');

  // Russian/Uzbek endings and typos
  for (const [text, want] of [['из Томска', 'Tomsk, RU'], ['в Ташкент', 'Tashkent, UZ'], ['Ташкента', 'Tashkent, UZ'], ['Toshkend', 'Tashkent, UZ'], ['Самарканду', 'Samarkand, UZ'], ['Тошкентга', 'Tashkent, UZ']]) assert.equal(label(text), want, text);

  // never invents: unknown / nonsense is "not found", and a wrong country hint cannot hide a real match
  assert.equal(label('Atlantis'), null);
  assert.equal(label('???'), null);
  assert.equal(label('Tashkent', { country: 'RU' }), 'Tashkent, UZ');
  assert.equal(label('Viloyati oblast region'), null, 'filler words alone match nothing');

  // the model's own label pick is verified; the coordinate fallback finds the nearest listed town
  assert.equal(label('whatever', { label: 'Urgench, UZ' }), 'Urgench, UZ');
  assert.equal(label('Томск', { label: 'Narnia, XX' }), 'Tomsk, RU');
  const near = resolveCity(index, { text: 'Zzzzzz', country: 'RU', lat: 56.45, lng: 84.97 });
  assert.equal(near.city?.label, 'Tomsk, RU');
  assert.equal(near.how, 'nearest');
  assert.equal(resolveCity(index, { text: 'Zzzzzz', country: 'RU', lat: 10, lng: 10 }).city, null, 'nothing within reach -> not found');
  assert.ok(fold('Тошкент') === fold('Toshkent'));
});

test('city autocomplete: scripts, regions with a hint, aliases, typos, country filter, big towns first', () => {
  const top = (q, opts) => searchCities(index, q, opts);
  const labels = (q, opts) => top(q, opts).map((h) => h.city.label);
  assert.equal(labels('xorazm')[0], 'Urgench, UZ');
  assert.equal(top('xorazm')[0].note, 'Xorazm', 'the hint tells the person why Urgench appeared');
  assert.equal(labels('ташк')[0], 'Tashkent, UZ');
  assert.equal(labels('samarq')[0], 'Samarkand, UZ');
  assert.equal(labels('toshk')[0], 'Tashkent, UZ');
  assert.ok(labels('asin').includes('Asino, RU'));
  assert.equal(labels('urganch')[0], 'Urgench, UZ');
  assert.ok(labels('Toshkend').includes('Tashkent, UZ'), 'typo-tolerant');
  assert.ok(labels('kom').every((l, i, a) => i === 0 || true) && labels('kom').length > 0);
  assert.ok(labels('sam', { country: 'UZ' }).every((l) => l.endsWith(', UZ')), 'country filter');
  assert.equal(top('', { limit: 3 }).length, 3, 'empty query -> the biggest towns');
  assert.equal(labels('Narnia').length, 0);
  // population breaks ties: the big Kazan beats a village that merely starts the same way
  assert.equal(labels('kaz')[0], 'Kazan, RU');
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

  assert.equal(d[0].originCity, 'Asino, RU', 'the specific town, not just the region it is in');
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

  assert.equal(d[1].originCity, 'Elektrogorsk, RU');
  assert.equal(d[1].destCity, 'Urgench, UZ', 'Хоразм is a region -> its main city');
  assert.ok(!d[1].flags.includes('dest'));
  assert.equal(d[2].originCity, 'Balabanovo, RU');
  assert.equal(d[2].destCity, 'Tashkent, UZ');
  assert.equal(d[3].originCity, 'Lyudinovo, RU');
  assert.equal(d[3].destCity, 'Bukhara, UZ');
  assert.match(d[3].notes, /Also DEL: Urgench, UZ/, 'extra destinations are kept in the notes');
});

test('parse-loads: model output is verified, never trusted', async () => {
  const hostile = {
    name: 'fake',
    async parseLoads() {
      return { loads: [
        { origin: { text: 'Almaty', city: 'Almaty', country: 'KZ' }, destinations: [{ text: 'Tashkent', cityLabel: 'Tashkent, UZ' }], equipment: ['T', 'ROCKET', 'r'],
          fullOrPartial: 'Maybe', weightT: 9999, pickupDate: '2026-02-31', rateUsd: -5, commodity: 'x'.repeat(500), notes: 'n'.repeat(900), phone: '+998 90 123 45 67', telegram: null, contactName: null, evil: '<script>' },
        { origin: { text: 'Narnia', city: 'Narnia', country: 'XX', lat: 0, lng: 0 }, destinations: [], equipment: [], commodity: '', notes: '' },
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
  const sys = seen.body.systemInstruction.parts[0].text;
  assert.ok(!/Tomsk, RU/.test(sys) && sys.length < 12_000, 'no giant city list in the prompt: the server matches places itself');
  assert.match(sys, /Xorazm/, 'regions are explained to the model');
  assert.match(sys, /UNTRUSTED DATA/);
  assert.match(loadsPrompt({ today: '2026-10-06' }), /Today is 2026-10-06/);
  assert.match(trucksPrompt({ today: '2026-10-06' }), /AVAILABLE TRUCK/);
  await g.parseTrucks({ text: 'truck', today: '2026-10-06' });
  assert.ok(seen.body.generationConfig.responseSchema.properties.trucks, 'trucks use their own schema');

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
    const lastContact = await api.patch('/api/me/profile', { phone: '' });
    assert.equal(lastContact.status, 400, 'the last way to be reached cannot be cleared');
    assert.equal(lastContact.json.error.details[0].code, 'contact_required');
    assert.equal((await api.patch('/api/me/profile', { telegram: '@new_co' })).status, 200);
    assert.equal((await api.patch('/api/me/profile', { phone: '' })).status, 200, 'one contact can be cleared while the other stays');
    const noCompany = await api.patch('/api/me/profile', { company: '', contactName: 'Nodir' });
    assert.equal(noCompany.status, 200, 'company is optional');
    assert.equal(noCompany.json.profile.company, 'Nodir', 'the name stands in for a missing company');
    assert.equal((await api.patch('/api/me/profile', { location: 'Tashkent' })).json.profile.contactName, 'Nodir', 'a partial update never blanks other fields');
    assert.equal((await fresh.app.inject({ method: 'GET', url: '/api/config' })).json().aiImport, 'basic');
  } finally { await fresh.close(); }
  const off = await startTestEnv({}, { ai: null });
  try { assert.equal((await off.app.inject({ method: 'GET', url: '/api/config' })).json().aiImport, false); } finally { await off.close(); }
  const real = await startTestEnv({}, { ai: createGeminiParser({ apiKey: 'k' }) });
  try { assert.equal((await real.app.inject({ method: 'GET', url: '/api/config' })).json().aiImport, 'ai'); } finally { await real.close(); }
});

test('Gemini client: falls through retired/overloaded models, retries once, and stops on a bad key', async () => {
  const calls = [];
  const ok = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"loads":[]}' }] } }] }) };
  const reply = (status) => ({ ok: false, status, text: async () => `err ${status}` });
  const scripted = (plan) => async (url) => { const m = /models\/([^:]+):/.exec(url)[1]; calls.push(m); return plan(m, calls.filter((c) => c === m).length); };
  const make = (plan, model = 'a,b,c') => createGeminiParser({ apiKey: 'K', model, retryDelayMs: 1, fetchImpl: scripted(plan) });
  const run = (g) => g.parseLoads({ text: 'x', cities: [], today: '' });

  calls.length = 0;
  assert.deepEqual(await run(make((m) => (m === 'a' ? reply(404) : ok))), { loads: [] });
  assert.deepEqual(calls, ['a', 'b'], 'a retired model (404) hands over immediately');

  calls.length = 0;
  assert.deepEqual(await run(make((m, n) => (m === 'a' && n === 1 ? reply(503) : ok))), { loads: [] });
  assert.deepEqual(calls, ['a', 'a'], 'an overloaded model is retried once');

  calls.length = 0;
  assert.deepEqual(await run(make((m) => (m === 'c' ? ok : reply(503)))), { loads: [] });
  assert.deepEqual(calls, ['a', 'a', 'b', 'b', 'c'], 'persistent overload moves down the list');

  calls.length = 0;
  await assert.rejects(run(make(() => reply(403))), (e) => e.code === 'ai_failed');
  assert.deepEqual(calls, ['a'], 'a rejected key is not retried on other models');

  calls.length = 0;
  await assert.rejects(run(make(() => reply(503))), (e) => e.code === 'ai_busy' && e.status === 503);
  await assert.rejects(run(make(() => reply(429))), (e) => e.code === 'ai_busy');
});
