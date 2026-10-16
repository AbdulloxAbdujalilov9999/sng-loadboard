// Puts the bot's menu and start-page text into Telegram: the "/" command menu and the short / long descriptions people see
// before they press Start. Uzbek is the default for everybody; Russian-speaking phones get Russian. Best effort - a failure here
// (e.g. Telegram unreachable for a moment) is logged and never stops the bot.
import { COMMAND_MENU, COMMAND_MENU_LITE, BOT_ABOUT, BOT_ABOUT_LITE } from './i18n.js';

export async function publishBotProfile(telegram, log = console, variant = 'full') {
  const menu = variant === 'lite' ? COMMAND_MENU_LITE : COMMAND_MENU;
  const about = variant === 'lite' ? BOT_ABOUT_LITE : BOT_ABOUT;
  const cmds = (lang) => menu[lang].map(([command, description]) => ({ command, description }));
  // [language_code, texts]: no code = the default everybody falls back to; "uz" is set explicitly too
  // "en" is set to Uzbek on purpose: phones in English must not see an English menu either (an older version of this bot
  // had published one, and Telegram keeps a per-language menu until it is overwritten).
  const targets = [[undefined, 'uz'], ['uz', 'uz'], ['en', 'uz'], ['ru', 'ru']];
  for (const [code, lang] of targets) {
    const extra = code ? { language_code: code } : {};
    try {
      await telegram.setMyCommands(cmds(lang), extra);
      await telegram.setMyShortDescription(about[lang].short, code);
      await telegram.setMyDescription(about[lang].long, code);
      log.info?.(`bot menu + start text published (${code ?? 'default'}: ${lang})`);
    } catch (err) {
      log.warn?.(`could not update the bot menu (${code ?? 'default'}): ${err.message}`);
    }
  }
}
