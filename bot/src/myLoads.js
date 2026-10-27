// /myloads: the member's own loads, ONE MESSAGE EACH, as full cards (everything the board shows) with Edit / Renew / Delete buttons.
// Editing itself lives in editor.js (shared with the review of a pasted post); this file lists, renews and deletes.
import { Markup } from 'telegraf';
import { NotLinkedError } from './tokens.js';
import { ApiError } from './apiClient.js';
import { dtoToRow, escapeHtml, formatLoadMessage } from './format.js';
import { loadKeyboard } from './editor.js';
import { t } from './i18n.js';

export { parseEditValue } from './editor.js';

const MAX_CARDS = 10;

export function makeMyLoads({ apiClient, tokens, cleaner = null }) {
  const card = (l, lang) => formatLoadMessage(dtoToRow(l), lang);
  const route = (l) => `${l.originCity} → ${l.destCity}`;

  // Editing a message to the same content makes Telegram answer 400 "message is not modified"; a message that was deleted
  // meanwhile (the bot pulls a deleted load's copy out of the chat) is gone. Neither is an error for us.
  const show = async (ctx, text, keyboard) => {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard ?? {}) }); } catch (err) {
      if (!/not modified|message to edit not found|message can't be edited/i.test(err?.description ?? err?.message ?? '')) throw err;
    }
  };

  async function token(ctx, edit = false) {
    try { return await tokens.getIdToken(ctx.from.id); } catch (err) {
      const msg = t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error');
      await (edit ? show(ctx, msg) : ctx.reply(msg));
      return null;
    }
  }

  async function list(ctx) {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'myloads_dm_only')); return; }
    const idToken = await token(ctx);
    if (!idToken) return;
    let items;
    try { ({ items } = await apiClient.listMine(idToken)); } catch { await ctx.reply(t(ctx.lang, 'postload_unreachable')); return; }
    if (!items.length) { await ctx.reply(t(ctx.lang, 'myloads_empty')); return; }
    const header = await ctx.reply(t(ctx.lang, 'myloads_header', { count: items.length }));
    const sent = [header?.message_id];
    for (const l of items.slice(0, MAX_CARDS)) sent.push((await ctx.reply(card(l, ctx.lang), { parse_mode: 'HTML', ...loadKeyboard(ctx.lang, l.id) }))?.message_id);
    if (items.length > MAX_CARDS) await ctx.reply(t(ctx.lang, 'myloads_more', { n: items.length - MAX_CARDS }));
    if (cleaner) { // «Clear from chat» on the last message: takes the list off the screen, the loads stay where they are
      const token = cleaner.register({ userId: ctx.from.id, chatId: ctx.chat.id, msgIds: sent });
      await ctx.reply('🧹', Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'chat_clear_btn'), `chat:clear:${token}`)]]));
    }
  }

  // One handler per button. The load is looked up fresh each time, so the card always shows what is on the board right now.
  async function withLoad(ctx, id, fn) {
    await ctx.answerCbQuery().catch(() => {});
    const idToken = await token(ctx, true);
    if (!idToken) return;
    let l;
    try { l = (await apiClient.listMine(idToken)).items.find((x) => x.id === Number(id)); } catch { await show(ctx, t(ctx.lang, 'postload_unreachable')); return; }
    if (!l) { await show(ctx, t(ctx.lang, 'myloads_gone')); return; }
    await fn(idToken, l);
  }

  const showCard = (ctx, id) => withLoad(ctx, id, (_tok, l) => show(ctx, card(l, ctx.lang), loadKeyboard(ctx.lang, l.id)));
  const askDelete = (ctx, id) => withLoad(ctx, id, (_tok, l) => show(ctx, `${card(l, ctx.lang)}\n\n⚠️ ${t(ctx.lang, 'myloads_confirm')}`, Markup.inlineKeyboard([
    [Markup.button.callback(t(ctx.lang, 'myloads_btn_yes'), `myloads:del:${l.id}`), Markup.button.callback(t(ctx.lang, 'myloads_btn_no'), `myloads:card:${l.id}`)],
  ])));
  const confirmDelete = (ctx, id) => withLoad(ctx, id, async (idToken, l) => {
    try {
      await apiClient.deleteLoad(idToken, l.id);
      await show(ctx, t(ctx.lang, 'myloads_deleted_named', { route: escapeHtml(route(l)) }));
    } catch { await show(ctx, t(ctx.lang, 'myloads_delete_failed')); }
  });
  const renew = (ctx, id) => withLoad(ctx, id, async (idToken, l) => {
    try {
      const fresh = await apiClient.renewLoad(idToken, l.id);
      await show(ctx, `${card(fresh, ctx.lang)}\n\n${t(ctx.lang, 'myloads_renewed')}`, loadKeyboard(ctx.lang, l.id));
    } catch { await show(ctx, `${card(l, ctx.lang)}\n\n${t(ctx.lang, 'myloads_renew_failed')}`, loadKeyboard(ctx.lang, l.id)); }
  });

  // 🔁 Repost (free, with a cooldown) and ⭐ TOP (spends a credit): the card stays, a line under it says what happened.
  const note = (ctx, l, text) => show(ctx, `${card(l, ctx.lang)}\n\n${text}`, loadKeyboard(ctx.lang, l.id));
  const repost = (ctx, id) => withLoad(ctx, id, async (idToken, l) => {
    try {
      const fresh = await apiClient.repostLoad(idToken, l.id);
      const hours = Math.max(1, Math.round((Date.parse(fresh.nextRepostAt) - Date.now()) / 3_600_000));
      await note(ctx, fresh, t(ctx.lang, 'myloads_reposted', { hours }));
    } catch (err) {
      const wait = err instanceof ApiError && err.status === 429 ? err.details?.find((d) => d.code === 'repost_wait') : null;
      await note(ctx, l, wait ? t(ctx.lang, 'myloads_repost_wait', { min: wait.params?.min ?? '?' }) : t(ctx.lang, 'myloads_action_failed'));
    }
  });
  const top = (ctx, id) => withLoad(ctx, id, async (idToken, l) => {
    try {
      const fresh = await apiClient.boostLoad(idToken, l.id);
      const me = await apiClient.getMe(idToken).catch(() => null);
      await note(ctx, fresh, t(ctx.lang, 'myloads_topped', { hours: me?.growth?.boostHours ?? 24, credits: fresh.boostCredits ?? '∞' }));
    } catch (err) {
      await note(ctx, l, t(ctx.lang, err instanceof ApiError && err.status === 402 ? 'myloads_no_credits' : 'myloads_action_failed'));
    }
  });

  return { list, showCard, askDelete, confirmDelete, renew, repost, top };
}
