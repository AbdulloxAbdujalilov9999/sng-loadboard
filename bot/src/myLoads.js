// /myloads: the member's own loads as full cards (everything the board shows), each with Edit / Renew / Delete buttons.
// Editing asks for one new value at a time and sends it to PATCH /api/loads/:id, so the server's rules decide what is valid -
// the bot only turns what a person types ("1500", "ertaga", "@username") into the fields the API expects.
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { dtoToRow, escapeHtml, formatLoadMessage } from './format.js';
import { t } from './i18n.js';

export const EDIT_FIELDS = ['rate', 'date', 'weight', 'commodity', 'notes', 'phone', 'telegram'];
const EDIT_TTL_MS = 10 * 60_000;
const MAX_CARDS = 10;
const TASHKENT_OFFSET_MS = 5 * 3_600_000;

const ymd = (d) => d.toISOString().slice(0, 10);
const today = (now) => new Date(now.getTime() + TASHKENT_OFFSET_MS); // the calendar day in Tashkent (UTC+5), where most members are

/** What a person typed -> the PATCH body, or null when it makes no sense for that field. Never throws. */
export function parseEditValue(field, raw, now = new Date()) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  switch (field) {
    case 'rate': {
      if (/^(0|-|kelishiladi|kelishilgan|договорная|negotiable)$/i.test(text)) return { rateUsd: 0 };
      const n = Number(text.replace(/[\s$]/g, '').replace(',', '.'));
      return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? { rateUsd: n } : null;
    }
    case 'date': {
      const low = text.toLowerCase();
      const base = today(now);
      if (/^(bugun|сегодня|today)$/.test(low)) return { pickupDate: ymd(base) };
      if (/^(ertaga|завтра|tomorrow)$/.test(low)) return { pickupDate: ymd(new Date(base.getTime() + 86_400_000)) };
      let y; let m; let d;
      let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (match) [, y, m, d] = match;
      else if ((match = text.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/))) {
        [, d, m, y] = match;
        if (!y) { y = base.getUTCFullYear(); if (Date.UTC(y, m - 1, d) < base.getTime() - 7 * 86_400_000) y += 1; } // "05.01" typed in December means next January
        else if (y.length === 2) y = `20${y}`;
      } else return null;
      const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null; // 31.02 etc.
      return { pickupDate: ymd(date) };
    }
    case 'weight': {
      const n = Number(text.toLowerCase().replace(/(tonna|тонн\w*|ton|t|т)\s*$/, '').replace(',', '.').trim());
      return Number.isFinite(n) && n > 0 && n <= 100 ? { weightT: n } : null;
    }
    case 'commodity':
      return text.length <= 200 ? { commodity: text } : null;
    case 'notes':
      if (text === '-') return { notes: '' };
      return text.length <= 500 ? { notes: text } : null;
    case 'phone': {
      if (text === '-') return { contactPhone: '' };
      const digits = text.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return null;
      return { contactPhone: text.startsWith('+') || digits.length !== 9 ? `+${digits}` : `+998${digits}` };
    }
    case 'telegram': {
      if (text === '-') return { contactTelegram: '' };
      const name = text.replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
      return /^[A-Za-z0-9_]{4,32}$/.test(name) ? { contactTelegram: `@${name}` } : null;
    }
    default:
      return null;
  }
}

export function makeMyLoads({ apiClient, tokens, log = console }) {
  const card = (l, lang) => formatLoadMessage(dtoToRow(l), lang);
  const route = (l) => `${l.originCity} → ${l.destCity}`;

  const mainKeyboard = (lang, id) => Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, 'myloads_btn_edit'), `myloads:edit:${id}`), Markup.button.callback(t(lang, 'myloads_btn_renew'), `myloads:renew:${id}`)],
    [Markup.button.callback(t(lang, 'myloads_btn_delete'), `myloads:ask:${id}`)],
  ]);
  const fieldKeyboard = (lang, id) => {
    const btn = (f) => Markup.button.callback(t(lang, `edit_btn_${f}`), `myloads:f:${id}:${f}`);
    return Markup.inlineKeyboard([
      [btn('rate'), btn('date')], [btn('weight'), btn('commodity')], [btn('notes'), btn('phone')],
      [btn('telegram'), Markup.button.callback(t(lang, 'edit_btn_back'), `myloads:card:${id}`)],
    ]);
  };

  // Editing a message to the same content makes Telegram answer 400 "message is not modified": that is not an error for us.
  const show = async (ctx, text, keyboard) => {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard ?? {}) }); } catch (err) {
      if (!/not modified/i.test(err?.description ?? err?.message ?? '')) throw err;
    }
  };

  async function token(ctx, edit = false) {
    try { return await tokens.getIdToken(ctx.from.id); } catch (err) {
      const msg = t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error');
      await (edit ? show(ctx, msg) : ctx.reply(msg));
      return null;
    }
  }
  async function findMine(idToken, id) {
    const { items } = await apiClient.listMine(idToken);
    return items.find((x) => x.id === Number(id)) ?? null;
  }

  async function list(ctx) {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'myloads_dm_only')); return; }
    const idToken = await token(ctx);
    if (!idToken) return;
    let items;
    try { ({ items } = await apiClient.listMine(idToken)); } catch { await ctx.reply(t(ctx.lang, 'postload_unreachable')); return; }
    if (!items.length) { await ctx.reply(t(ctx.lang, 'myloads_empty')); return; }
    await ctx.reply(t(ctx.lang, 'myloads_header', { count: items.length }));
    for (const l of items.slice(0, MAX_CARDS)) await ctx.reply(card(l, ctx.lang), { parse_mode: 'HTML', ...mainKeyboard(ctx.lang, l.id) });
    if (items.length > MAX_CARDS) await ctx.reply(t(ctx.lang, 'myloads_more', { n: items.length - MAX_CARDS }));
  }

  // One handler per button. `load` is looked up fresh each time, so the card always shows what is on the board right now.
  async function withLoad(ctx, id, fn) {
    await ctx.answerCbQuery().catch(() => {});
    const idToken = await token(ctx, true);
    if (!idToken) return;
    let l;
    try { l = await findMine(idToken, id); } catch { await show(ctx, t(ctx.lang, 'postload_unreachable')); return; }
    if (!l) { await show(ctx, t(ctx.lang, 'myloads_gone')); return; }
    await fn(idToken, l);
  }

  const showCard = (ctx, id) => withLoad(ctx, id, (_tok, l) => show(ctx, card(l, ctx.lang), mainKeyboard(ctx.lang, l.id)));
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
      await show(ctx, `${card(fresh, ctx.lang)}\n\n${t(ctx.lang, 'myloads_renewed')}`, mainKeyboard(ctx.lang, l.id));
    } catch { await show(ctx, `${card(l, ctx.lang)}\n\n${t(ctx.lang, 'myloads_renew_failed')}`, mainKeyboard(ctx.lang, l.id)); }
  });
  const editMenu = (ctx, id) => withLoad(ctx, id, (_tok, l) => show(ctx, `${card(l, ctx.lang)}\n\n✏️ ${t(ctx.lang, 'edit_pick')}`, fieldKeyboard(ctx.lang, l.id)));
  const pickField = (ctx, id, field) => withLoad(ctx, id, async (_tok, l) => {
    if (!EDIT_FIELDS.includes(field)) return;
    ctx.session.edit = { id: l.id, field, at: Date.now() };
    await ctx.reply(t(ctx.lang, `edit_ask_${field}`));
  });

  /** A plain text message while an edit is open: it is the new value. Returns true when it handled the message. */
  async function handleEditText(ctx) {
    const edit = ctx.session?.edit;
    if (!edit) return false;
    if (Date.now() - edit.at > EDIT_TTL_MS) { delete ctx.session.edit; await ctx.reply(t(ctx.lang, 'edit_expired')); return true; }
    const patch = parseEditValue(edit.field, ctx.message.text);
    if (!patch) { await ctx.reply(t(ctx.lang, 'edit_invalid', { why: t(ctx.lang, 'edit_invalid_format') })); return true; }
    const idToken = await token(ctx);
    if (!idToken) { delete ctx.session.edit; return true; }
    try {
      const updated = await apiClient.updateLoad(idToken, edit.id, patch);
      delete ctx.session.edit;
      await ctx.reply(`${t(ctx.lang, 'edit_saved')}\n\n${card(updated, ctx.lang)}`, { parse_mode: 'HTML', ...mainKeyboard(ctx.lang, edit.id) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        const why = err.details?.length ? err.details.map((d) => `${d.path}: ${d.code}`).join(', ') : err.message;
        await ctx.reply(t(ctx.lang, 'edit_invalid', { why }));
      } else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        delete ctx.session.edit;
        await ctx.reply(t(ctx.lang, 'myloads_gone'));
      } else {
        log.error?.(`load edit failed: ${err.message}`);
        await ctx.reply(t(ctx.lang, 'postload_unreachable'));
      }
    }
    return true;
  }

  async function cancel(ctx) {
    if (ctx.session?.edit) { delete ctx.session.edit; await ctx.reply(t(ctx.lang, 'edit_cancelled')); } else await ctx.reply(t(ctx.lang, 'edit_nothing'));
  }

  return { list, showCard, askDelete, confirmDelete, renew, editMenu, pickField, handleEditText, cancel };
}
