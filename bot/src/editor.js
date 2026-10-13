// One editor for every load the bot shows - a load that is already on the board (/myloads, and the copy the bot sends right after
// posting) and a draft that is still waiting for the "Post" tap after a paste. The same fields as the web app's edit window:
// pickup / delivery city, truck type, full / partial, weight, volume, dates, rate, cargo, notes and the contact. Buttons pick a field,
// then the person types the new value (or taps a choice); the target - a posted load or a draft - decides where it is saved.
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { dtoToRow, formatLoadMessage, formatMyTruck, formatTruckMessage } from './format.js';
import { t } from './i18n.js';

// The same editor serves four kinds of target: L = a load on the board, D = a draft waiting for the "Post" tap, T = a truck on the board,
// M = the member's saved "my truck". Each has its own field buttons (truck fields have their own names where the meaning differs from a load's).
const LOAD_ROWS = [['origin', 'dest'], ['equip', 'fp'], ['weight', 'volume'], ['date', 'delivery'], ['rate', 'commodity'], ['notes', 'name'], ['phone', 'telegram']];
const TRUCK_ROWS = [['loc', 'tdest'], ['equip', 'cap'], ['volume', 'avail'], ['availto', 'minrate'], ['tir', 'adr'], ['gps', 'side'], ['notes', 'phone'], ['telegram']];
const MYTRUCK_ROWS = [['loc', 'tdest'], ['equip', 'cap'], ['volume', 'tir'], ['adr', 'gps'], ['side', 'plate'], ['trailer', 'driver'], ['driverphone', 'notes']];
const ROWS = { L: LOAD_ROWS, D: LOAD_ROWS, T: TRUCK_ROWS, M: MYTRUCK_ROWS };
export const FIELDS = [...new Set(Object.values(ROWS).flat(2))];
export const CHOICES = { equip: ['T', 'R', 'F', 'V', 'AC'], fp: ['Full', 'Partial'], tir: ['1', '0'], adr: ['1', '0'], gps: ['1', '0'], side: ['1', '0'] };
const FLAG_FIELDS = { tir: 'hasTir', adr: 'hasAdr', gps: 'hasGps', side: 'sideLoading' };
const CITY_FIELDS = { origin: 'origin', dest: 'dest', loc: 'loc' }; // field -> the prefix of its <prefix>CityId in the API
const choicePatch = (field, value) => (FLAG_FIELDS[field] ? { [FLAG_FIELDS[field]]: value === '1' } : { [field]: value });
const EDIT_TTL_MS = 10 * 60_000;
const TASHKENT_OFFSET_MS = 5 * 3_600_000;

const ymd = (d) => d.toISOString().slice(0, 10);

/** A date as people write it: 2026-10-15, 15.10, 15.10.26, "bugun", "ertaga" (also Russian / English). null when it is not a real date. */
export function parseDate(text, now = new Date()) {
  const low = String(text).trim().toLowerCase();
  const base = new Date(now.getTime() + TASHKENT_OFFSET_MS); // the calendar day in Tashkent (UTC+5), where most members are
  if (/^(bugun|сегодня|today)$/.test(low)) return ymd(base);
  if (/^(ertaga|завтра|tomorrow)$/.test(low)) return ymd(new Date(base.getTime() + 86_400_000));
  let y; let m; let d;
  let match = low.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [, y, m, d] = match;
  else if ((match = low.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/))) {
    [, d, m, y] = match;
    if (!y) { y = base.getUTCFullYear(); if (Date.UTC(y, m - 1, d) < base.getTime() - 7 * 86_400_000) y += 1; } // "05.01" typed in December means next January
    else if (y.length === 2) y = `20${y}`;
  } else return null;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null; // 31.02 etc.
  return ymd(date);
}

/** What a person typed -> the PATCH body (the API's own field names), or null when it makes no sense for that field. Never throws. */
export function parseEditValue(field, raw, now = new Date()) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  switch (field) {
    case 'rate': {
      if (/^(0|-|kelishiladi|kelishilgan|договорная|negotiable)$/i.test(text)) return { rateUsd: 0 };
      const n = Number(text.replace(/[\s$]/g, '').replace(',', '.'));
      return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? { rateUsd: n } : null;
    }
    case 'date': { const d = parseDate(text, now); return d ? { pickupDate: d } : null; }
    case 'delivery': {
      if (text === '-') return { deliveryDate: null };
      const d = parseDate(text, now);
      return d ? { deliveryDate: d } : null;
    }
    case 'weight': {
      const n = Number(text.toLowerCase().replace(/(tonna|тонн\w*|ton|t|т)\s*$/, '').replace(',', '.').trim());
      return Number.isFinite(n) && n > 0 && n <= 100 ? { weightT: n } : null;
    }
    case 'volume': {
      if (text === '-') return { volumeM3: null };
      const n = Math.round(Number(text.toLowerCase().replace(/(m3|m³|м3|м³|kub|куб\w*)\s*$/, '').replace(',', '.').trim()));
      return Number.isFinite(n) && n >= 1 && n <= 200 ? { volumeM3: n } : null;
    }
    case 'cap': {
      const n = Number(text.toLowerCase().replace(/(tonna|тонн\w*|ton|t|т)\s*$/, '').replace(',', '.').trim());
      return Number.isFinite(n) && n > 0 && n <= 100 ? { capacityT: n } : null;
    }
    case 'tdest':
      if (text === '-') return { destPref: '' };
      return text.length <= 120 ? { destPref: text } : null;
    case 'avail': { const d = parseDate(text, now); return d ? { availableFrom: d } : null; }
    case 'availto': {
      if (text === '-') return { availableTo: null };
      const d = parseDate(text, now);
      return d ? { availableTo: d } : null;
    }
    case 'minrate': {
      if (/^(0|-|kelishiladi|kelishilgan|договорная|negotiable)$/i.test(text)) return { minRateUsd: null };
      const n = Number(text.replace(/[\s$]/g, '').replace(',', '.'));
      return Number.isFinite(n) && n > 0 && n <= 1_000_000 ? { minRateUsd: n } : null;
    }
    case 'plate': return text === '-' ? { plate: '' } : text.length <= 20 ? { plate: text } : null;
    case 'trailer': return text === '-' ? { trailerPlate: '' } : text.length <= 20 ? { trailerPlate: text } : null;
    case 'driver': return text === '-' ? { driverName: '' } : text.length <= 80 ? { driverName: text } : null;
    case 'driverphone': {
      if (text === '-') return { driverPhone: '' };
      const digits = text.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return null;
      return { driverPhone: text.startsWith('+') || digits.length !== 9 ? `+${digits}` : `+998${digits}` };
    }
    case 'commodity':
      return text.length <= 200 ? { commodity: text } : null;
    case 'notes':
      if (text === '-') return { notes: '' };
      return text.length <= 500 ? { notes: text } : null;
    case 'name':
      return text.length <= 120 ? { contactName: text } : null;
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

/** Edit / Renew / Delete under a load that is on the board. */
export const loadKeyboard = (lang, id) => Markup.inlineKeyboard([
  [Markup.button.callback(t(lang, 'myloads_btn_edit'), `ed:menu:L${id}`), Markup.button.callback(t(lang, 'myloads_btn_renew'), `myloads:renew:${id}`)],
  [Markup.button.callback(t(lang, 'myloads_btn_delete'), `myloads:ask:${id}`)],
]);

/** Edit / Renew / Delete under a truck that is on the board. */
export const truckKeyboard = (lang, id) => Markup.inlineKeyboard([
  [Markup.button.callback(t(lang, 'myloads_btn_edit'), `ed:menu:T${id}`), Markup.button.callback(t(lang, 'myloads_btn_renew'), `mytr:renew:${id}`)],
  [Markup.button.callback(t(lang, 'myloads_btn_delete'), `mytr:ask:${id}`)],
]);

/** Under the saved "my truck" card. */
export const myTruckKeyboard = (lang) => Markup.inlineKeyboard([
  [Markup.button.callback(t(lang, 'myloads_btn_edit'), 'ed:menu:M'), Markup.button.callback(t(lang, 'mt_btn_loads'), 'mt:loads')],
  [Markup.button.callback(t(lang, 'mt_btn_post'), 'mt:post'), Markup.button.callback(t(lang, 'myloads_btn_delete'), 'mt:ask')],
]);

const parseTarget = (s) => {
  if (s === 'M') return { kind: 'M' };
  if (s?.[0] === 'T') return { kind: 'T', id: Number(s.slice(1)) };
  if (s?.[0] === 'L') return { kind: 'L', id: Number(s.slice(1)) };
  if (s?.[0] === 'D') { const [batch, idx] = s.slice(1).split('.'); return { kind: 'D', batch, idx: Number(idx) }; }
  return null;
};

export function makeEditor({ apiClient, tokens, draftAdapter, log = console }) {
  // Editing a message to the same content makes Telegram answer 400 "not modified"; a message the person deleted is "not found".
  // Neither is an error for us.
  const quiet = (err) => /not modified|message to edit not found|message can't be edited/i.test(err?.description ?? err?.message ?? '');
  const show = async (ctx, text, keyboard) => {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard ?? {}) }); } catch (err) { if (!quiet(err)) throw err; }
  };
  const notify = (ctx, text) => (ctx.callbackQuery ? show(ctx, text) : ctx.reply(text));

  // ---- target 1: a load that is on the board ----
  const loadAdapter = {
    async load(ctx, ref) {
      let idToken;
      try { idToken = await tokens.getIdToken(ctx.from.id); } catch (err) {
        await notify(ctx, t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error'));
        return null;
      }
      let l;
      try { l = (await apiClient.listMine(idToken)).items.find((x) => x.id === ref.id); } catch { await notify(ctx, t(ctx.lang, 'postload_unreachable')); return null; }
      if (!l) { await notify(ctx, t(ctx.lang, 'myloads_gone')); return null; }
      return { idToken, l };
    },
    view: (ctx, { l }) => ({ text: formatLoadMessage(dtoToRow(l), ctx.lang), keyboard: loadKeyboard(ctx.lang, l.id) }),
    async apply(ctx, ref, { idToken }, patch) {
      return { idToken, l: await apiClient.updateLoad(idToken, ref.id, patch) };
    },
  };
  // ---- target 3: a truck that is on the board ----
  const truckAdapter = {
    async load(ctx, ref) {
      let idToken;
      try { idToken = await tokens.getIdToken(ctx.from.id); } catch (err) {
        await notify(ctx, t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error'));
        return null;
      }
      let x;
      try { x = (await apiClient.listMyTrucks(idToken)).items.find((it) => it.id === ref.id); } catch { await notify(ctx, t(ctx.lang, 'postload_unreachable')); return null; }
      if (!x) { await notify(ctx, t(ctx.lang, 'mytr_gone')); return null; }
      return { idToken, x };
    },
    view: (ctx, { x }) => ({ text: formatTruckMessage(x, ctx.lang), keyboard: truckKeyboard(ctx.lang, x.id) }),
    async apply(ctx, ref, { idToken }, patch) { return { idToken, x: await apiClient.updateTruck(idToken, ref.id, patch) }; },
  };

  // ---- target 4: the saved "my truck" (member profile) ----
  const myTruckAdapter = {
    async load(ctx) {
      let idToken;
      try { idToken = await tokens.getIdToken(ctx.from.id); } catch (err) {
        await notify(ctx, t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error'));
        return null;
      }
      let mt;
      try { mt = (await apiClient.getMe(idToken)).profile?.myTruck; } catch { await notify(ctx, t(ctx.lang, 'postload_unreachable')); return null; }
      if (!mt) { await notify(ctx, t(ctx.lang, 'mt_none')); return null; }
      return { idToken, mt };
    },
    view: (ctx, { mt }) => ({ text: formatMyTruck(mt, ctx.lang), keyboard: myTruckKeyboard(ctx.lang) }),
    async apply(ctx, ref, { idToken, mt }, patch) {
      const { locCity, ...rest } = { ...mt, ...patch }; // the server adds the city's name itself and refuses it in the body
      const { profile } = await apiClient.putMyTruck(idToken, rest);
      return { idToken, mt: profile.myTruck };
    },
  };
  const adapters = { L: loadAdapter, D: draftAdapter, T: truckAdapter, M: myTruckAdapter };

  const fieldKeyboard = (lang, target) => Markup.inlineKeyboard([
    ...ROWS[target[0]].map((row) => row.map((f) => Markup.button.callback(t(lang, `edit_btn_${f}`), `ed:f:${target}:${f}`))),
    [Markup.button.callback(t(lang, 'edit_btn_back'), `ed:back:${target}`)],
  ]);

  const open = async (ctx, target) => {
    await ctx.answerCbQuery().catch(() => {});
    const ref = parseTarget(target);
    const adapter = ref && adapters[ref.kind];
    if (!adapter) return null;
    const item = await adapter.load(ctx, ref);
    return item ? { ref, adapter, item } : null;
  };

  async function menu(ctx, target) {
    const o = await open(ctx, target);
    if (o) await show(ctx, `${o.adapter.view(ctx, o.item).text}\n\n✏️ ${t(ctx.lang, 'edit_pick')}`, fieldKeyboard(ctx.lang, target));
  }
  async function back(ctx, target) {
    const o = await open(ctx, target);
    if (o) { const v = o.adapter.view(ctx, o.item); await show(ctx, v.text, v.keyboard); }
  }

  async function pick(ctx, target, field) {
    const o = await open(ctx, target);
    if (!o || !ROWS[o.ref.kind].flat().includes(field)) return;
    if (CHOICES[field]) {
      const label = (code) => (field === 'equip' ? t(ctx.lang, `eq_${code}`) : FLAG_FIELDS[field] ? t(ctx.lang, code === '1' ? 'edit_yes' : 'edit_no') : t(ctx.lang, code === 'Full' ? 'wiz_fp_full' : 'wiz_fp_partial'));
      const rows = CHOICES[field].map((code) => Markup.button.callback(label(code), `ed:set:${target}:${field}:${code}`));
      await show(ctx, `${o.adapter.view(ctx, o.item).text}\n\n${t(ctx.lang, `edit_ask_${field}`)}`, Markup.inlineKeyboard([
        ...Array.from({ length: Math.ceil(rows.length / 2) }, (_, i) => rows.slice(i * 2, i * 2 + 2)),
        [Markup.button.callback(t(ctx.lang, 'edit_btn_back'), `ed:menu:${target}`)],
      ]));
      return;
    }
    ctx.session.edit = { target, field, at: Date.now(), msgId: ctx.callbackQuery?.message?.message_id };
    await ctx.reply(t(ctx.lang, `edit_ask_${field}`));
  }

  async function choose(ctx, target, field, value) {
    const o = await open(ctx, target);
    if (!o || !CHOICES[field]?.includes(value)) return;
    try {
      const updated = await o.adapter.apply(ctx, o.ref, o.item, choicePatch(field, value), {});
      const v = o.adapter.view(ctx, updated);
      await show(ctx, v.text, v.keyboard);
    } catch (err) { await show(ctx, t(ctx.lang, 'edit_invalid', { why: errorWhy(ctx, err) })); }
  }

  const errorWhy = (ctx, err) => (err instanceof ApiError && err.details?.length ? err.details.map((d) => `${d.path}: ${d.code}`).join(', ') : err.message);

  // Saves `patch` on the current edit's target and refreshes the message the person pressed "Edit" on.
  async function commit(ctx, edit, patch, extra = {}) {
    const ref = parseTarget(edit.target);
    const adapter = ref && adapters[ref.kind];
    const item = adapter && await adapter.load(ctx, ref);
    if (!item) { delete ctx.session.edit; return; }
    try {
      const updated = await adapter.apply(ctx, ref, item, patch, extra);
      delete ctx.session.edit;
      const v = adapter.view(ctx, updated);
      let refreshed = false;
      if (edit.msgId) {
        try { await ctx.telegram.editMessageText(ctx.chat.id, edit.msgId, undefined, v.text, { parse_mode: 'HTML', ...v.keyboard }); refreshed = true; } catch (err) { refreshed = quiet(err) && /not modified/i.test(err?.description ?? ''); }
      }
      await ctx.reply(refreshed ? t(ctx.lang, 'edit_saved') : `${t(ctx.lang, 'edit_saved')}\n\n${v.text}`, { parse_mode: 'HTML', ...(refreshed ? {} : v.keyboard) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) await ctx.reply(t(ctx.lang, 'edit_invalid', { why: errorWhy(ctx, err) }));
      else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) { delete ctx.session.edit; await ctx.reply(t(ctx.lang, 'myloads_gone')); } else {
        log.error?.(`load edit failed: ${err.message}`);
        await ctx.reply(t(ctx.lang, 'postload_unreachable'));
      }
    }
  }

  /** A plain text message while an edit is open: it is the new value. Returns true when it handled the message. */
  async function handleText(ctx) {
    const edit = ctx.session?.edit;
    if (!edit) return false;
    if (Date.now() - edit.at > EDIT_TTL_MS) { delete ctx.session.edit; await ctx.reply(t(ctx.lang, 'edit_expired')); return true; }
    const text = ctx.message.text.trim();
    if (CITY_FIELDS[edit.field]) {
      let idToken;
      try { idToken = await tokens.getIdToken(ctx.from.id); } catch { delete ctx.session.edit; await ctx.reply(t(ctx.lang, 'postload_session_error')); return true; }
      let items = [];
      try { ({ items } = await apiClient.searchCities(idToken, text, 6)); } catch { await ctx.reply(t(ctx.lang, 'postload_unreachable')); return true; }
      if (!items.length) { await ctx.reply(t(ctx.lang, 'edit_city_none')); return true; }
      edit.options = Object.fromEntries(items.map((c) => [c.id, c.label]));
      await ctx.reply(t(ctx.lang, 'edit_city_pick'), Markup.inlineKeyboard([
        ...items.map((c) => [Markup.button.callback(c.label, `ed:city:${c.id}`)]),
        [Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), 'ed:cancel')],
      ]));
      return true;
    }
    const patch = parseEditValue(edit.field, text);
    if (!patch) { await ctx.reply(t(ctx.lang, 'edit_invalid', { why: t(ctx.lang, 'edit_invalid_format') })); return true; }
    await commit(ctx, edit, patch);
    return true;
  }

  async function city(ctx, cityId) {
    await ctx.answerCbQuery().catch(() => {});
    const edit = ctx.session?.edit;
    const label = edit?.options?.[cityId];
    if (!edit || !label || Date.now() - edit.at > EDIT_TTL_MS) { await ctx.reply(t(ctx.lang, 'edit_city_expired')); return; }
    const key = CITY_FIELDS[edit.field];
    await commit(ctx, edit, { [`${key}CityId`]: Number(cityId) }, { [`${key}City`]: label });
  }

  async function cancel(ctx) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    if (ctx.session?.edit) { delete ctx.session.edit; await ctx.reply(t(ctx.lang, 'edit_cancelled')); } else if (!ctx.callbackQuery) await ctx.reply(t(ctx.lang, 'edit_nothing'));
  }

  return { menu, back, pick, choose, handleText, city, cancel };
}
