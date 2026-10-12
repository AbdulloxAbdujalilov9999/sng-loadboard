// Puts the bot's menu and start-page text into Telegram: the "/" command menu and the short / long descriptions people see
// before they press Start. Uzbek is the default for everybody; Russian-speaking phones get Russian. Best effort - a failure here
// (e.g. Telegram unreachable for a moment) is logged and never stops the bot.
import { COMMAND_MENU, BOT_ABOUT } from './i18n.js';

export async function publishBotProfile(telegram, log = console) {
  const cmds = (lang) => COMMAND_MENU[lang].map(([command, description]) => ({ command, description }));
  // [language_code, texts]: no code = the default everybody falls back to; "uz" is set explicitly too
  const targets = [[undefined, 'uz'], ['uz', 'uz'], ['ru', 'ru']];
  for (const [code, lang] of targets) {
    const extra = code ? { language_code: code } : {};
    try {
      await telegram.setMyCommands(cmds(lang), extra);
      await telegram.setMyShortDescription(BOT_ABOUT[lang].short, code);
      await telegram.setMyDescription(BOT_ABOUT[lang].long, code);
    } catch (err) {
      log.warn?.(`could not update the bot menu (${code ?? 'default'}): ${err.message}`);
    }
  }
}
