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
  const allowed = new Set(['method_google', 'lbl_telegram', 'ai_placeholder', 'eq_F', 'lbl_email', 'lbl_email_btn']);
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
