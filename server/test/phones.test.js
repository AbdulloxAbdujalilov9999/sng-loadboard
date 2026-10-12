import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { findPhones, normalizePhone, distinctPhones } from '../src/lib/ai/phones.js';
import { createHeuristicParser } from '../src/lib/ai/heuristic.js';
import { loadsPrompt, trucksPrompt } from '../src/lib/ai/gemini.js';
import { startTestEnv } from './helpers.js';

test('every way truckers write a phone number becomes the same +998 number', () => {
  for (const w of ['979242400', '97 924 2400', '97924 24 00', '97-924-24-00', '97.924.24.00', '(97) 924 24 00', '9 7 9 2 4 2 4 0 0', '979242400   🔥🔥🔥', '+998 97 924 24 00', '+998979242400', '998979242400', '998 97 924 24 00', '0 97 924 24 00', '00998979242400']) {
    assert.equal(normalizePhone(w), '+998979242400', `"${w}"`);
  }
  assert.equal(normalizePhone('8 (903) 123-45-67'), '+79031234567');
  assert.equal(normalizePhone('+7 701 123 45 67'), '+77011234567');
  assert.equal(normalizePhone('9031234567'), '+79031234567');
  assert.equal(normalizePhone('+996 555 123 456'), '+996555123456');
  assert.equal(normalizePhone('996555123456'), '+996555123456');
  for (const bad of ['', 'abc', '22', '12345', '2026', '1 500 000', '22 Т']) assert.equal(normalizePhone(bad), '', `"${bad}" is not a phone`);
});

test('phones are found inside a post - weights, truck counts, prices and dates are not phones', () => {
  const post = '🇺🇿Самарканд\n🇷🇺ЕКАТЕРИНБУРГ\nТЕНТ 3\n22 Т\nМЕТАЛЛ РУЛОН 1 500 $\n12.10.2026 14:30\n979242400   🔥🔥🔥';
  assert.deepEqual(findPhones(post).map((p) => p.phone), ['+998979242400']);
  assert.deepEqual(distinctPhones('97 924 2400 ... 979242400 ... +998979242400'), ['+998979242400'], 'one number written three ways is one number');
  assert.deepEqual(distinctPhones('979242400\n\n90 123 45 67'), ['+998979242400', '+998901234567']);
  assert.deepEqual(findPhones('ТЕНТ 3\n22 Т\n23 Т'), [], 'digits on different lines are never glued together');
});

test('the AI prompts teach the model about bare, spaced and digit-by-digit numbers', () => {
  for (const p of [loadsPrompt({ today: '2026-10-12' }), trucksPrompt({ today: '2026-10-12' })]) {
    assert.match(p, /CONTACT NUMBERS/);
    assert.match(p, /979242400/);
    assert.match(p, /9 7 9 2 4 2 4 0 0/);
    assert.match(p, /\+998 plus the 9 digits/);
    assert.match(p, /Do NOT mistake other numbers/);
  }
});

const MESSAGE = `🇺🇿Самарканд
🇷🇺ЕКАТЕРИНБУРГ
ТЕНТ 3
22 Т
МЕТАЛЛ РУЛОН
979242400   🔥🔥🔥

🇺🇿Самарканд
🇷🇺КРАСНОЯРСК
ТЕНТ 1
22 Т
МЕТАЛЛ РУЛОН
97 924 2400

🇺🇿Самарканд
🇷🇺МОСКВА (ОДИНЦОВА)
ТЕНТ 5
23  Т
МЕТАЛЛ РУЛОН
97924 24 00

🇺🇿Самарканд
🇷🇺УФА
ТЕНТ 5
22 Т
МЕТАЛЛ РУЛОН
9 7 9 2 4 2 4 0 0

🇺🇿Самарканд
🇦🇿БАКУ
ТЕНТ 2
22 Т
МЕТАЛЛ РУЛОН
+998 97 924 24 00`;

let env;
before(async () => { env = await startTestEnv({}, { ai: createHeuristicParser() }); await env.approvedMember('ph@test.com'); });
after(async () => { await env.close(); });

test('parse-loads: every post of a pasted message comes back with its contact, whatever the format', async () => {
  const r = await env.as('ph@test.com').post('/api/ai/parse-loads', { text: MESSAGE });
  assert.equal(r.status, 200);
  assert.equal(r.json.loads.length, 5);
  assert.deepEqual(r.json.loads.map((l) => l.contactPhone), Array(5).fill('+998979242400'));
  assert.ok(r.json.loads.every((l) => !/979|924/.test(l.notes)), 'the number is not left in the notes');
});

test('parse-loads: a model that returns a number in any format (or forgets it) still gives clean contacts', async () => {
  const model = { name: 'sloppy', async parseLoads() {
    const place = (text, country) => ({ text, city: text, country });
    const base = { destinations: [place('Moscow', 'RU')], equipment: ['T'], fullOrPartial: 'Full', weightT: 20, commodity: 'x', notes: '' };
    return { loads: [
      { ...base, origin: place('Samarkand', 'UZ'), phone: '97 924 2400' },
      { ...base, origin: place('Samarkand', 'UZ'), phone: '979242400' },
      { ...base, origin: place('Samarkand', 'UZ'), phone: '+998 97 924 24 00' },
      { ...base, origin: place('Samarkand', 'UZ'), phone: null },                  // forgotten: the text has just one number
      { ...base, origin: place('Samarkand', 'UZ'), phone: 'call me' },            // nonsense
    ] };
  } };
  const e2 = await startTestEnv({}, { ai: model });
  try {
    await e2.approvedMember('x@test.com');
    const r = await e2.as('x@test.com').post('/api/ai/parse-loads', { text: 'Samarkand Moscow 20 t tent\n97 924 2400\n\nSamarkand Moscow 20 t tent 979242400' });
    assert.deepEqual(r.json.loads.map((l) => l.contactPhone), Array(5).fill('+998979242400'));
    // two different numbers in the paste: nobody can say which load the forgotten one belongs to - it stays empty
    const r2 = await e2.as('x@test.com').post('/api/ai/parse-loads', { text: 'Samarkand Moscow\n97 924 2400\n\nSamarkand Moscow\n90 123 45 67' });
    assert.deepEqual(r2.json.loads.map((l) => l.contactPhone), ['+998979242400', '+998979242400', '+998979242400', '', '']);
  } finally { await e2.close(); }
});
