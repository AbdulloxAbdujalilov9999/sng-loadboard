import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_MENU, BOT_ABOUT, t } from '../src/i18n.js';
import { publishBotProfile } from '../src/profile.js';

test('the Telegram menu follows Telegram\'s own rules and is translated', () => {
  for (const lang of ['uz', 'ru']) {
    assert.ok(COMMAND_MENU[lang].length <= 100);
    for (const [command, description] of COMMAND_MENU[lang]) {
      assert.match(command, /^[a-z0-9_]{1,32}$/, `${command}: lowercase Latin only`);
      assert.ok(description.length >= 3 && description.length <= 256, `${lang}/${command} description length`);
    }
    assert.ok(BOT_ABOUT[lang].short.length <= 120, `${lang} short description`);
    assert.ok(BOT_ABOUT[lang].long.length <= 512, `${lang} description`);
  }
  assert.deepEqual(COMMAND_MENU.uz.map((c) => c[0]), COMMAND_MENU.ru.map((c) => c[0]), 'same commands in every language');
  assert.ok(COMMAND_MENU.uz.some(([c]) => c === 'paste'), '/paste is in the menu');
  assert.ok(!COMMAND_MENU.uz.some(([, d]) => /\b(the|your|load|post)\b/i.test(d)), 'Uzbek menu has no English words');
});

test('publishBotProfile sets Uzbek as the default and keeps going if one call fails', async () => {
  const calls = [];
  const telegram = {
    setMyCommands: async (cmds, extra) => { calls.push(['commands', extra?.language_code ?? 'default', cmds.length]); },
    setMyShortDescription: async (text, code) => { calls.push(['short', code ?? 'default', text]); },
    setMyDescription: async (text, code) => { if (code === 'ru') throw new Error('flood'); calls.push(['long', code ?? 'default']); },
  };
  const warnings = [];
  await publishBotProfile(telegram, { warn: (m) => warnings.push(m) });
  assert.ok(calls.some((c) => c[0] === 'commands' && c[1] === 'default'), 'default menu is set');
  assert.equal(calls.find((c) => c[0] === 'short' && c[1] === 'default')[2], BOT_ABOUT.uz.short, 'default text is Uzbek');
  assert.ok(calls.some((c) => c[0] === 'commands' && c[1] === 'ru'), 'Russian menu is still set');
  assert.ok(calls.some((c) => c[0] === 'commands' && c[1] === 'en'), 'the English menu is overwritten (with Uzbek), not left over from an older version');
  assert.equal(calls.find((c) => c[0] === 'short' && c[1] === 'en')[2], BOT_ABOUT.uz.short);
  assert.equal(warnings.length, 1);
});

test('/paste texts exist in every language, and Uzbek is really Uzbek', () => {
  for (const key of ['paste_howto', 'paste_too_short', 'unknown_command']) {
    for (const lang of ['en', 'ru', 'uz']) assert.ok(t(lang, key) !== key, `${lang}.${key}`);
  }
  assert.match(t('uz', 'paste_howto'), /joylang/);
});
