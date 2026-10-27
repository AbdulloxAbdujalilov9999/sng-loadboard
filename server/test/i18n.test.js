import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// The browser app is plain scripts, so load the dictionaries the same way a browser would.
const root = new URL('../../web/', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const src = read('js/i18n.js');
const DICT = vm.runInNewContext(`${src.slice(src.indexOf('const DICT'), src.indexOf('const I18N')).replace('const DICT', 'DICT')}; DICT`);
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('English, Russian and Uzbek have exactly the same keys', () => {
  const keys = (l) => Object.keys(DICT[l]).sort();
  for (const lang of ['ru', 'uz']) {
    assert.deepEqual(keys(lang).filter((k) => !(k in DICT.en)), [], `${lang} has keys English lacks`);
    assert.deepEqual(keys('en').filter((k) => !(k in DICT[lang])), [], `${lang} is missing keys`);
  }
  assert.ok(keys('en').length > 300);
});

test('every translation keeps the same {placeholders} and none is empty', () => {
  for (const lang of ['ru', 'uz']) {
    for (const [k, v] of Object.entries(DICT[lang])) {
      assert.ok(String(v).trim(), `${lang}.${k} is empty`);
      assert.equal(placeholders(v), placeholders(DICT.en[k]), `${lang}.${k} placeholders differ from English`);
    }
  }
});

test('Uzbek and Russian are really translated (not left in English)', () => {
  const same = (lang) => Object.entries(DICT[lang]).filter(([k, v]) => v === DICT.en[k] && /[a-z]{4}/i.test(v));
  // brand names / codes / shared words are allowed to match
  const allowed = new Set(['method_google', 'lbl_telegram', 'ai_placeholder', 'eq_F', 'lbl_email', 'lbl_email_btn', 'persona_broker']);
  assert.deepEqual(same('uz').map(([k]) => k).filter((k) => !allowed.has(k)), [], 'untranslated Uzbek strings');
  assert.deepEqual(same('ru').map(([k]) => k).filter((k) => !allowed.has(k)), [], 'untranslated Russian strings');
});

test('every data-i18n key used in the page and every t("key") call exists', () => {
  const html = read('index.html');
  const used = new Set([...html.matchAll(/data-i18n(?:-placeholder)?="([a-z0-9_]+)"/g)].map((m) => m[1]));
  for (const f of fs.readdirSync(new URL('js/', root))) {
    if (f === 'i18n.js') continue;
    for (const m of read(`js/${f}`).matchAll(/\bt\('([a-z0-9_]+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in DICT.en));
  assert.deepEqual(missing, [], 'keys used by the app but not defined');
});

test('every error message the server can send is translated for members (Uzbek and Russian)', () => {
  const api = read('js/api.js');
  const out = {};
  for (const lang of ['en', 'ru', 'uz']) {
    const t = (key, vars) => (DICT[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => vars?.[k] ?? '');
    out[lang] = vm.runInNewContext(`${api}; localizeServerMessage`, { window: { t, APP_CONFIG: {} }, console });
  }
  // the messages are collected from the server's own source, so a new one cannot be forgotten
  const messages = new Set();
  const dir = new URL('../src/', import.meta.url);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [new URL(e.name, d)]));
  const re = /(?:badRequest|forbidden|notFound|conflict|tooMany|unauthorized|new HttpError\(\s*\d+,\s*'[\w]+',)\s*\(?\s*(['`])((?:\\.|(?!\1).)*)\1/g;
  for (const f of walk(dir).filter((u) => u.pathname.endsWith('.js'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) messages.add(m[2].replace(/\$\{[^}]*\}/g, '5'));
  }
  assert.ok(messages.size > 30, `found ${messages.size} server messages`);
  const skip = (m) => m === ', message: ' || m === '5';
  for (const m of messages) {
    if (skip(m)) continue;
    for (const lang of ['ru', 'uz']) {
      const got = out[lang](undefined, m);
      assert.notEqual(got, m, `${lang}: "${m}" is shown to members in English`);
      assert.doesNotMatch(got, /\{\w+\}/, `${lang}: "${m}" has an unfilled placeholder`);
    }
  }
  assert.match(out.uz(undefined, 'You have reached the limit of 100 active loads. Remove some to post more.'), /100/);
  assert.equal(out.uz('not_approved_rejected', 'Your access request is rejected'), DICT.uz.srv_blocked);
  assert.equal(out.uz('rate_limited', 'whatever'), DICT.uz.srv_too_fast);
  assert.equal(out.uz(undefined, 'something new the server says'), 'something new the server says', 'unknown messages stay as the server wrote them');
});

test('titles and aria-labels in the page are translated (no English tooltip left behind)', () => {
  const html = read('index.html');
  const used = [...html.matchAll(/data-i18n-(?:title|aria)="([a-z0-9_]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 15);
  for (const k of used) assert.ok(k in DICT.uz, `missing ${k}`);
  const left = [...html.matchAll(/\s(title|aria-label)="([^"]*[A-Za-z]{3,}[^"]*)"/g)].map((m) => m[2]).filter((v) => v !== 'Dev email');
  assert.deepEqual(left, [], 'hard-coded English title / aria-label attributes');
});
