// "My truck" in the bot (the Profile section): the vehicle a driver describes once - type, capacity, volume, TIR/ADR/GPS, where it usually
// stands, plates, driver. It is the same saved truck the website's Settings page shows (PUT /api/me/truck), and it becomes the default for
// «Loads for my truck» and for «Post a truck». The field-by-field editing is editor.js (target "M"); this file shows it and sets it up.
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { formatMyTruck } from './format.js';
import { myTruckKeyboard, parseEditValue } from './editor.js';
import { t } from './i18n.js';

const EQUIP = ['T', 'R', 'F', 'V', 'AC'];
const TTL_MS = 10 * 60_000;

export function makeMyTruck({ apiClient, tokens, loadMember, trucks, nearby }) {
  /** The menu button / command: the saved truck as a card, or how to add one. */
  async function show(ctx) {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'link_dm_only')); return; }
    const m = await loadMember(ctx);
    if (!m) return;
    const mt = m.member.myTruck;
    if (!mt) {
      await ctx.reply(t(ctx.lang, 'mt_none'), Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'mt_btn_setup'), 'mt:new')]]));
      return;
    }
    await ctx.reply(formatMyTruck(mt, ctx.lang), { parse_mode: 'HTML', ...myTruckKeyboard(ctx.lang) });
  }

  async function setup(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup?.({ inline_keyboard: [] }).catch(() => {});
    delete ctx.session.mtnew;
    await ctx.reply(t(ctx.lang, 'ptr_ask_equip'), Markup.inlineKeyboard([
      ...[0, 2, 4].map((i) => EQUIP.slice(i, i + 2).map((c) => Markup.button.callback(t(ctx.lang, `eq_${c}`), `mt:eq:${c}`))),
    ]));
  }

  async function chooseEquip(ctx, code) {
    await ctx.answerCbQuery().catch(() => {});
    if (!EQUIP.includes(code)) return;
    await ctx.editMessageReplyMarkup?.({ inline_keyboard: [] }).catch(() => {});
    ctx.session.mtnew = { equip: code, at: Date.now() };
    await ctx.reply(t(ctx.lang, 'ptr_ask_cap'));
  }

  /** The capacity typed after choosing the type: the truck is saved with just those two, the rest is added with Edit. */
  async function handleText(ctx) {
    const s = ctx.session?.mtnew;
    if (!s) return false;
    if (Date.now() - s.at > TTL_MS) { delete ctx.session.mtnew; return false; }
    const p = parseEditValue('cap', ctx.message.text);
    if (!p) { await ctx.reply(t(ctx.lang, 'edit_invalid', { why: t(ctx.lang, 'edit_invalid_format') })); return true; }
    let idToken;
    try { idToken = await tokens.getIdToken(ctx.from.id); } catch { delete ctx.session.mtnew; await ctx.reply(t(ctx.lang, 'postload_session_error')); return true; }
    try {
      const { profile } = await apiClient.putMyTruck(idToken, { equip: s.equip, capacityT: p.capacityT });
      delete ctx.session.mtnew;
      await ctx.reply(`${formatMyTruck(profile.myTruck, ctx.lang)}\n\n${t(ctx.lang, 'mt_saved_hint')}`, { parse_mode: 'HTML', ...myTruckKeyboard(ctx.lang) });
    } catch (err) {
      await ctx.reply(err instanceof ApiError && err.status === 400 ? t(ctx.lang, 'edit_invalid', { why: err.message }) : t(ctx.lang, 'postload_unreachable'));
    }
    return true;
  }

  async function ask(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(`${ctx.callbackQuery?.message?.text ?? ''}\n\n⚠️ ${t(ctx.lang, 'mt_confirm')}`.trim(), Markup.inlineKeyboard([[
      Markup.button.callback(t(ctx.lang, 'myloads_btn_yes'), 'mt:del'), Markup.button.callback(t(ctx.lang, 'myloads_btn_no'), 'mt:keep'),
    ]])).catch(() => {});
  }
  async function keep(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageText(t(ctx.lang, 'mt_kept')).catch(() => {});
  }
  async function remove(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    let idToken;
    try { idToken = await tokens.getIdToken(ctx.from.id); } catch { await ctx.reply(t(ctx.lang, 'postload_session_error')); return; }
    try { await apiClient.deleteMyTruck(idToken); await ctx.editMessageText(t(ctx.lang, 'mt_deleted')).catch(() => {}); } catch { await ctx.reply(t(ctx.lang, 'postload_unreachable')); }
  }

  const post = async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await trucks.begin(ctx, 'saved'); };
  const loads = async (ctx) => { await ctx.answerCbQuery().catch(() => {}); await nearby.truckLoads(ctx); };

  return { show, setup, chooseEquip, handleText, ask, keep, remove, post, loads };
}
