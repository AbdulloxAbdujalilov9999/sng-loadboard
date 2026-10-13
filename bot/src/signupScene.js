// Create an SNG ONE account without leaving Telegram: name, phone number, a 4-6 digit password (asked twice) - then the account exists,
// this Telegram is linked to it, and the bot sends a button that opens the website already signed in (a one-time link).
// The password message is deleted the moment it arrives.
import { Scenes, Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { escapeHtml } from './format.js';
import { normalizePhone, performLink } from './linkScene.js';
import { mainKeyboard } from './menu.js';
import { t } from './i18n.js';

/** Asks the server for a one-time website link and answers with the button that opens it (or the plain link where Telegram refuses a button). */
export async function sendWebLogin(ctx, { apiClient, tokens, config, intro }) {
  let code;
  try {
    const idToken = await tokens.getIdToken(ctx.from.id);
    ({ code } = await apiClient.createLoginLink(idToken));
  } catch {
    await ctx.reply(t(ctx.lang, 'weblogin_failed'));
    return false;
  }
  const url = `${config.webBaseUrl}/?login=${code}`;
  const text = `${intro ? `${intro}\n\n` : ''}${t(ctx.lang, 'weblogin_msg')}`;
  // Telegram only accepts public https addresses as buttons; on a local test setup the link goes in the text.
  if (config.webUrlIsPublic === false) await ctx.reply(`${text}\n\n${escapeHtml(url)}`, { parse_mode: 'HTML' });
  else await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.url(t(ctx.lang, 'weblogin_btn'), url)]]) });
  return true;
}

export function makeSignupScene({ apiClient, store, tokens, config }) {
  const scene = new Scenes.BaseScene('signup');

  scene.enter(async (ctx) => {
    ctx.scene.state.step = 'name';
    await ctx.reply(t(ctx.lang, 'signup_ask_name'), Markup.removeKeyboard());
  });

  const finish = (ctx, message, extra = {}) => ctx.reply(message, { parse_mode: 'HTML', ...mainKeyboard(ctx.lang), ...extra }).then(() => ctx.scene.leave());
  scene.command('cancel', (ctx) => finish(ctx, t(ctx.lang, 'signup_cancelled')));

  async function askPhone(ctx) {
    ctx.scene.state.step = 'phone';
    await ctx.reply(t(ctx.lang, 'signup_ask_phone'), Markup.keyboard([[Markup.button.contactRequest(t(ctx.lang, 'link_share_phone'))]]).oneTime().resize());
  }

  async function havePhone(ctx, phone) {
    // Is this number already an account? Then signing up again would only confuse - point to the way in.
    try {
      const { exists } = await apiClient.phoneCheck(phone);
      if (exists) return finish(ctx, t(ctx.lang, 'signup_phone_taken'));
    } catch { /* the register call below reports an unreachable server */ }
    ctx.scene.state.phone = phone;
    ctx.scene.state.step = 'pin';
    return ctx.reply(t(ctx.lang, 'signup_ask_pin'), mainKeyboard(ctx.lang));
  }

  // "Share my number": only the person's OWN Telegram number is accepted.
  scene.on('contact', async (ctx) => {
    if (ctx.scene.state.step !== 'phone') return undefined;
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply(t(ctx.lang, 'link_contact_not_yours'));
    const phone = normalizePhone(c.phone_number);
    return phone ? havePhone(ctx, phone) : ctx.reply(t(ctx.lang, 'link_bad_phone'));
  });

  async function create(ctx) {
    const { name, phone, pin } = ctx.scene.state;
    try {
      await apiClient.phoneRegister({ phone, pin, contactName: name, telegram: ctx.from.username ? `@${ctx.from.username}` : '' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.details?.some((d) => d.code === 'phone_taken')) return finish(ctx, t(ctx.lang, 'signup_phone_taken'));
      if (err instanceof ApiError && err.status === 429) return finish(ctx, t(ctx.lang, 'signup_rate_limited'));
      return finish(ctx, t(ctx.lang, 'link_unreachable'));
    }
    // The account exists: this Telegram is linked to it right away (the same step /link does), and the website opens signed in.
    const linked = await performLink({ apiClient, store, tokens, from: ctx.from, phone, pin });
    await ctx.scene.leave();
    const intro = t(ctx.lang, 'signup_done', { name: escapeHtml(name), phone: escapeHtml(phone) });
    if (!linked.ok) { await ctx.reply(intro, { parse_mode: 'HTML', ...mainKeyboard(ctx.lang) }); return undefined; }
    await ctx.reply(t(ctx.lang, 'menu_ready'), mainKeyboard(ctx.lang));
    return sendWebLogin(ctx, { apiClient, tokens, config, intro });
  }

  scene.on('text', async (ctx) => {
    const state = ctx.scene.state;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return ctx.reply(t(ctx.lang, 'wiz_busy_finish_or_cancel'));

    if (state.step === 'name') {
      if (text.length < 2 || text.length > 120 || /^[\d\s+()-]+$/.test(text)) return ctx.reply(t(ctx.lang, 'signup_bad_name'));
      state.name = text;
      return askPhone(ctx);
    }
    if (state.step === 'phone') {
      const phone = normalizePhone(text);
      return phone ? havePhone(ctx, phone) : ctx.reply(t(ctx.lang, 'link_bad_phone'));
    }
    if (state.step === 'pin' || state.step === 'pin2') {
      ctx.deleteMessage(ctx.message.message_id).catch(() => {}); // the password is scrubbed from the chat, whatever happens next
      if (!/^\d{4,6}$/.test(text)) return ctx.reply(t(ctx.lang, 'link_bad_pin'));
      if (state.step === 'pin') { state.pin = text; state.step = 'pin2'; return ctx.reply(t(ctx.lang, 'signup_ask_pin2')); }
      if (text !== state.pin) { state.pin = null; state.step = 'pin'; return ctx.reply(t(ctx.lang, 'signup_pin_mismatch')); }
      return create(ctx);
    }
    return undefined;
  });

  return scene;
}
