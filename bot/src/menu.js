// The bot's main menu: a keyboard that stays at the bottom of the chat, so people tap instead of typing commands.
// The labels are translated; a tap arrives as ordinary text, so every language's label maps to the same action.
import { Markup } from 'telegraf';
import { LANGS, t } from './i18n.js';

export const MENU_ACTIONS = ['ai', 'post', 'posttruck', 'mytruck', 'nearloads', 'neartrucks', 'myloads', 'mytrucks', 'account', 'language', 'help', 'updates'];
const KEY = {
  ai: 'btn_menu_ai', post: 'btn_menu_post', posttruck: 'btn_menu_posttruck', mytruck: 'btn_menu_mytruck', nearloads: 'btn_menu_nearloads', neartrucks: 'btn_menu_neartrucks',
  myloads: 'btn_menu_myloads', mytrucks: 'btn_menu_mytrucks', account: 'btn_menu_account', language: 'btn_menu_language', help: 'btn_menu_help', updates: 'btn_menu_updates',
};

// Not .persistent(): the keyboard stays attached to the chat but starts collapsed, like any other
// reply keyboard - the person reopens it with Telegram's own keyboard icon instead of it popping
// open on every message.
/** The full keyboard in one language (private chats only - a group has no use for it). */
export const mainKeyboard = (lang) => Markup.keyboard([
  [t(lang, KEY.ai), t(lang, KEY.post)],
  [t(lang, KEY.posttruck), t(lang, KEY.mytruck)],
  [t(lang, KEY.nearloads), t(lang, KEY.neartrucks)],
  [t(lang, KEY.myloads), t(lang, KEY.mytrucks)],
  [t(lang, KEY.updates)],
  [t(lang, KEY.account), t(lang, KEY.language), t(lang, KEY.help)],
]).resize();

/** The lean keyboard (sngonebot): Mini App + account (login/signup) + updates only. */
export const liteKeyboard = (lang, miniAppUrl) => Markup.keyboard([
  ...(miniAppUrl ? [[Markup.button.webApp(t(lang, 'app_open'), miniAppUrl)]] : []),
  [t(lang, KEY.account)],
  [t(lang, KEY.updates)],
]).resize();

const BY_TEXT = new Map(LANGS.flatMap((lang) => MENU_ACTIONS.map((a) => [t(lang, KEY[a]), a])));

/** Which menu button a text is, in any language - or null. */
export const menuAction = (text) => BY_TEXT.get(String(text ?? '').trim()) ?? null;
export const MENU_TEXTS = [...BY_TEXT.keys()];
