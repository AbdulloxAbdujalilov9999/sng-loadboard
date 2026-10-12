import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatDraftBlock, formatPostedLine, isDraftPostable, money } from '../src/format.js';

const DRAFT = {
  originCityId: 1, originCity: 'Kazan, RU', originText: 'Казань',
  destCityId: 2, destCity: 'Tashkent, UZ', destText: 'Тошкент',
  equip: 'T', fp: 'Full', weightT: 23, volumeM3: null, pickupDate: '2026-10-15', rateUsd: 0,
  commodity: 'Granule', notes: '', contactPhone: '', contactTelegram: '', contactName: '', flags: [],
};

test('a resolved draft is postable; one with a missing city is not', () => {
  assert.equal(isDraftPostable(DRAFT), true);
  assert.equal(isDraftPostable({ ...DRAFT, originCityId: null }), false);
  assert.equal(isDraftPostable({ ...DRAFT, destCityId: null }), false);
  assert.equal(isDraftPostable({ ...DRAFT, destCityId: DRAFT.originCityId }), false); // same city
});

test('formats a draft block with route, equipment, weight, cargo, date and rate', () => {
  const block = formatDraftBlock(DRAFT, 1, 'en');
  assert.match(block, /#1 .*Kazan, RU → Tashkent, UZ/);
  assert.match(block, /Tent\/Tilt/);
  assert.match(block, /23 t/);
  assert.match(block, /Granule/);
  assert.match(block, /2026-10-15/);
  assert.match(block, /Negotiable/);
});

test('marks an unresolved draft with the 🚫 marker and a blocking-flag warning, not a soft one', () => {
  const block = formatDraftBlock({ ...DRAFT, destCityId: null, flags: ['dest'] }, 2, 'en');
  assert.match(block, /#2 🚫/);
  assert.match(block, /destination city not recognized/);
});

test('shows a soft warning (amber flag) without the 🚫 marker when the city is a guess', () => {
  const block = formatDraftBlock({ ...DRAFT, flags: ['origin_check'] }, 1, 'en');
  assert.doesNotMatch(block, /#1 🚫/);
  assert.match(block, /⚠️.*origin city is a guess/);
});

test('localizes equipment, load type and flags into Russian and Uzbek', () => {
  const ru = formatDraftBlock({ ...DRAFT, flags: ['weight'] }, 1, 'ru');
  assert.match(ru, /Тент/);
  assert.match(ru, /Полная/);
  assert.match(ru, /вес не указан/);

  const uz = formatDraftBlock({ ...DRAFT, fp: 'Partial' }, 1, 'uz');
  assert.match(uz, /Shtorali/);
  assert.match(uz, /Qisman/);
});

test('escapes HTML-sensitive characters in free text fields', () => {
  const block = formatDraftBlock({ ...DRAFT, commodity: '<script>alert(1)</script> & co' }, 1, 'en');
  assert.doesNotMatch(block, /<script>/);
  assert.match(block, /&lt;script&gt;/);
});

test('escapeHtml handles null/undefined safely', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('a rate of 0 is shown as "negotiable" in every language, never as $0', () => {
  assert.equal(money(0, 'en'), 'Negotiable');
  assert.equal(money(0, 'ru'), 'Договорная');
  assert.equal(money(0, 'uz'), 'Kelishiladi');
  assert.equal(money(1500, 'en'), '$1,500');
});

test('formatPostedLine links to the board when the web URL is public, plain text otherwise', () => {
  const row = { id: 42, originCity: 'Kazan, RU', destCity: 'Tashkent, UZ', pickupDate: '2026-10-15', rateUsd: 1500 };
  const linked = formatPostedLine(row, 'en', 'https://sng.example', true);
  assert.match(linked, /<a href="https:\/\/sng\.example\/\?load=42">/);
  const plain = formatPostedLine(row, 'en', 'http://localhost:8080', false);
  assert.doesNotMatch(plain, /<a href/);
  assert.match(plain, /Kazan, RU → Tashkent, UZ/);
});
