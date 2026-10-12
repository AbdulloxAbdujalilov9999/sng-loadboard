// Wires up every Telegram-facing command. Business logic (what a valid load is, quotas, who may
// post) stays on the server; this file's job is turning chat messages into the same API calls the
// web app makes, plus the things that are Telegram-only: linking an account, tracking which chats
// to broadcast to, and each person's own bot language (English/Russian/Uzbek, see i18n.js).
import { Telegraf, Scenes, session, Markup } from 'telegraf';
import { FirebaseAuthError, firebaseErrorKey } from './firebase.js';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { makePostLoadScene } from './wizard.js';
import { makeLinkScene, linkFailureText, normalizePhone, performLink } from './linkScene.js';
import { OWN_PREFIX } from './tokens.js';
import { escapeHtml, joinLines } from './format.js';
import { makeLangManager } from './lang.js';
import { makePasteFlow } from './pasteFlow.js';
import { makeMyLoads } from './myLoads.js';
import { t, LANGS, LANG_NAMES } from './i18n.js';

const BROADCAST_CHAT_TYPES = new Set(['group', 'supergroup', 'channel']);
// Phone sign-ups are keyed internally as p<digits>@phone.sng (see server/src/lib/identity.js): show the number instead.
const loginOf = (identity) => (/^p\d+@phone\.sng$/.test(identity) ? `+${identity.slice(1, -'@phone.sng'.length)}` : identity);

export function makeBot({ config, firebaseAuth, apiClient, tokens, store }) {
  const bot = new Telegraf(config.botToken);
  const lang = makeLangManager({ store });
  const pasteFlow = makePasteFlow({ apiClient, tokens, config });
  const myLoads = makeMyLoads({ apiClient, tokens });

  bot.use(session());
  bot.use(async (ctx, next) => { ctx.lang = await lang.getLang(ctx); return next(); });

  const stage = new Scenes.Stage([makePostLoadScene({ apiClient, config }), makeLinkScene({ apiClient, store, tokens })]);
  bot.use(stage.middleware());
  // Any command other than /cancel ends a half-finished edit, so the next thing typed is never mistaken for its value.
  bot.use((ctx, next) => {
    if (ctx.session?.edit && ctx.message?.text?.startsWith('/') && !/^\/cancel\b/.test(ctx.message.text)) delete ctx.session.edit;
    return next();
  });

  // Keeps the bot's chat list (for broadcasting) in sync with reality: fires whenever the bot's own
  // membership in a chat changes, in either direction. The confirmation message uses the fixed
  // broadcast language (config.broadcastLang), like the load broadcasts themselves - a group mixes
  // people, so there is no single "this group's language" to follow.
  bot.on('my_chat_member', async (ctx) => {
    const upd = ctx.myChatMember;
    if (!BROADCAST_CHAT_TYPES.has(upd.chat.type)) return;
    const status = upd.new_chat_member.status;
    if (status === 'member' || status === 'administrator') {
      await store.upsertChat({ chatId: upd.chat.id, chatType: upd.chat.type, title: upd.chat.title || '', addedBy: upd.from?.id });
      await ctx.telegram.sendMessage(upd.chat.id, t(config.broadcastLang, 'group_connected')).catch(() => {});
    } else if (status === 'left' || status === 'kicked') {
      await store.markChatRemoved(upd.chat.id);
    }
  });

  // Our own official channel/group (BOT_JOIN_CHANNEL/BOT_JOIN_GROUP), appended whenever set - see
  // format.js's joinLines.
  const welcomeText = (lang) => {
    const join = joinLines(config, lang);
    const text = `${t(lang, 'welcome')}\n\n${t(lang, 'welcome_paste')}`;
    return join ? `${text}\n\n${join}` : text;
  };
  bot.start((ctx) => ctx.reply(welcomeText(ctx.lang)));
  bot.help((ctx) => ctx.reply(welcomeText(ctx.lang)));

  bot.command('language', async (ctx) => {
    await ctx.reply(t(ctx.lang, 'language_prompt'), Markup.inlineKeyboard(
      LANGS.map((code) => [Markup.button.callback(LANG_NAMES[code], `lang:${code}`)]),
    ));
  });
  bot.action(/^lang:(en|ru|uz)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const code = ctx.match[1];
    await lang.setLang(ctx.from.id, code);
    await ctx.editMessageText(t(code, 'language_set'));
  });

  // /link: phone number + 4-digit PIN (the ones from the website). Without arguments the bot asks for them one by one;
  // "/link +998901234567 1234" does it in one message.
  bot.command('link', async (ctx) => {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'link_dm_only')); return; }
    const args = ctx.message.text.replace(/^\/link(?:@\S+)?/, '').trim();
    if (!args) { await ctx.scene.enter('link'); return; }
    ctx.deleteMessage(ctx.message.message_id).catch(() => {}); // the PIN is in this message
    const m = args.match(/^(.+?)\s+(\d{4,6})$/);
    const phone = m && normalizePhone(m[1]);
    if (!phone) { await ctx.reply(t(ctx.lang, 'link_usage')); return; }
    const r = await performLink({ apiClient, store, tokens, from: ctx.from, phone, pin: m[2] });
    if (r.ok) await ctx.reply(t(ctx.lang, 'link_success', { company: escapeHtml(r.company) }), { parse_mode: 'HTML' });
    else await ctx.reply(linkFailureText(ctx.lang, r));
  });

  // /linkemail: the older way, for accounts made with e-mail + password (kept so nobody is locked out).
  bot.command('linkemail', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(t(ctx.lang, 'link_dm_only'));
      return;
    }
    const m = ctx.message.text.match(/^\/linkemail(?:@\S+)?\s+(\S+)\s+(.+)$/s);
    if (!m) { await ctx.reply(t(ctx.lang, 'link_email_usage')); return; }
    const [, email, password] = m;
    ctx.deleteMessage(ctx.message.message_id).catch(() => {}); // best-effort: scrub the password from the chat log

    let signIn;
    try {
      signIn = await firebaseAuth.signInWithPassword(email, password);
    } catch (err) {
      const key = err instanceof FirebaseAuthError ? firebaseErrorKey(err.code) : 'fb_generic';
      await ctx.reply(t(ctx.lang, key, { code: err.code }));
      return;
    }

    let me;
    try {
      me = await apiClient.getMe(signIn.idToken);
    } catch (err) {
      // The API refuses e-mail accounts whose address was never confirmed (401): that is the person's to fix, not an outage.
      await ctx.reply(t(ctx.lang, err instanceof ApiError && err.status === 401 ? 'link_unverified' : 'link_unreachable'));
      return;
    }
    if (!me.profile) {
      await ctx.reply(t(ctx.lang, 'link_no_account'));
      return;
    }
    if (me.profile.status !== 'approved') {
      await ctx.reply(t(ctx.lang, 'link_not_approved', { status: t(ctx.lang, `status_${me.profile.status}`) }));
      return;
    }

    await store.saveLink({
      memberId: me.profile.id, telegramUserId: ctx.from.id, telegramUsername: ctx.from.username || '', refreshToken: signIn.refreshToken,
    });
    tokens.invalidate(ctx.from.id);
    await ctx.reply(t(ctx.lang, 'link_success', { company: escapeHtml(me.profile.company) }), { parse_mode: 'HTML' });
  });

  bot.command('unlink', async (ctx) => {
    const removed = await store.removeLink(ctx.from.id);
    tokens.invalidate(ctx.from.id);
    await ctx.reply(t(ctx.lang, removed ? 'unlink_done' : 'unlink_none'));
  });

  bot.command('mystatus', async (ctx) => {
    const link = await store.getLinkByTelegramUserId(ctx.from.id);
    if (!link) { await ctx.reply(t(ctx.lang, 'mystatus_none')); return; }
    await ctx.reply(t(ctx.lang, 'mystatus_linked', {
      company: escapeHtml(link.company), login: escapeHtml(loginOf(link.email)), status: t(ctx.lang, `status_${link.member_status}`),
    }), { parse_mode: 'HTML' });
  });

  bot.command('postload', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply(t(ctx.lang, 'postload_dm_only'));
      return;
    }
    let idToken;
    try {
      idToken = await tokens.getIdToken(ctx.from.id);
    } catch (err) {
      await ctx.reply(t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error'));
      return;
    }
    let me;
    try {
      me = await apiClient.getMe(idToken);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && (await store.getLinkByTelegramUserId(ctx.from.id))?.refreshToken?.startsWith(OWN_PREFIX)) {
        await store.removeLink(ctx.from.id); // the PIN was changed (or the account removed): the old link can never work again
        tokens.invalidate(ctx.from.id);
        await ctx.reply(t(ctx.lang, 'postload_session_error'));
        return;
      }
      await ctx.reply(t(ctx.lang, 'postload_unreachable'));
      return;
    }
    if (!me.profile || me.profile.status !== 'approved') {
      await ctx.reply(t(ctx.lang, 'postload_not_approved'));
      return;
    }
    await ctx.scene.enter('postload', { idToken, member: me.profile });
  });

  // /myloads: everything I've posted as full cards with Edit / Renew / Delete buttons (myLoads.js). Delete is the same soft-close the
  // web app's "Remove" button does, which also pulls the load back out of every group/DM it was broadcast to (broadcaster.js).
  bot.command('myloads', (ctx) => myLoads.list(ctx));
  bot.action(/^myloads:card:(\d+)$/, (ctx) => myLoads.showCard(ctx, ctx.match[1]));
  bot.action(/^myloads:ask:(\d+)$/, (ctx) => myLoads.askDelete(ctx, ctx.match[1]));
  bot.action(/^myloads:del:(\d+)$/, (ctx) => myLoads.confirmDelete(ctx, ctx.match[1]));
  bot.action(/^myloads:renew:(\d+)$/, (ctx) => myLoads.renew(ctx, ctx.match[1]));
  bot.action(/^myloads:edit:(\d+)$/, (ctx) => myLoads.editMenu(ctx, ctx.match[1]));
  bot.action(/^myloads:f:(\d+):(\w+)$/, (ctx) => myLoads.pickField(ctx, ctx.match[1], ctx.match[2]));
  bot.action('myloads:cancel', async (ctx) => { // buttons on older messages
    await ctx.answerCbQuery();
    await ctx.editMessageText(t(ctx.lang, 'myloads_cancelled'));
  });
  bot.command('cancel', (ctx) => myLoads.cancel(ctx));

  // ---- AI paste-import: paste or forward a freight post in a DM and the bot reads it with AI ----
  // /paste on its own explains how; "/paste <the whole post>" does it in one message.
  bot.command('paste', async (ctx) => {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'paste_dm_only')); return undefined; }
    const text = ctx.message.text.replace(/^\/paste(?:@\S+)?/, '').trim();
    if (!text) { await ctx.reply(t(ctx.lang, 'paste_howto')); return undefined; }
    return pasteFlow.handleText(ctx, text);
  });
  bot.action(/^paste:confirm:([0-9a-f-]+)$/, (ctx) => pasteFlow.handleConfirm(ctx, ctx.match[1]));
  bot.action(/^paste:cancel:([0-9a-f-]+)$/, (ctx) => pasteFlow.handleCancel(ctx, ctx.match[1]));
  // Any plain text in a DM that is not a command and not inside a scene (/link, /postload answers go to the scene
  // first) is treated as a pasted freight post. Registered LAST so every command and the active scene get first refusal.
  // Groups are never read: the bot only listens to a member's own DM.
  bot.on('text', (ctx) => {
    if (ctx.chat.type !== 'private') return undefined;
    if (ctx.message.text.startsWith('/')) return ctx.reply(t(ctx.lang, 'unknown_command'));
    return myLoads.handleEditText(ctx).then((handled) => (handled ? undefined : pasteFlow.handleText(ctx)));
  });

  bot.catch((err, ctx) => {
    console.error(`bot error for update ${ctx.update.update_id}:`, err instanceof ApiError ? `${err.code}: ${err.message}` : err);
    ctx.reply?.(t(ctx.lang ?? 'en', 'generic_error')).catch(() => {});
  });

  return bot;
}
