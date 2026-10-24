// Trucks in the Telegram bot: drivers and dispatchers post trucks, not only loads.
//   * «Post a truck» - three ways in: the saved "my truck" (only the place, the date and the destination are asked), step by step for any
//     other truck, or "describe it" - paste / forward a post and the AI reads it (same /api/ai/parse-trucks the website uses).
//   * «My trucks» - the member's own trucks as cards, one message each, with Edit / Renew / Delete (editing itself is editor.js).
// Nothing here decides what a valid truck is: every call goes through the same API as the website.
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { escapeHtml, formatTruckDraft, formatTruckMessage } from './format.js';
import { parseDate, parseEditValue, truckKeyboard } from './editor.js';
import { withRetry } from './retry.js';
import { t } from './i18n.js';

const MAX_CARDS = 10;
const MAX_REVIEW = 10;                 // trucks in one review message (Telegram cuts a message at 4096 characters)
const FLOW_TTL_MS = 15 * 60_000;
const EQUIP = ['T', 'R', 'F', 'V', 'AC'];
const STEPS = ['equip', 'cap', 'loc', 'date', 'dest'];
const TASHKENT_OFFSET_MS = 5 * 3_600_000;
const ymd = (d) => d.toISOString().slice(0, 10);

const quiet = (err) => /not modified|message to edit not found|message can't be edited/i.test(err?.description ?? err?.message ?? '');

export function makeTrucks({ apiClient, tokens, config, cleaner = null, loadMember, log = console }) {
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pasteBuf = new Map();   // telegram user id -> { texts, timer, ctx, waitId, sourceIds }  (pasted posts waiting to be read as one)
  const reviews = new Map();    // telegram user id -> { id, drafts, member, msgId, chatId, at }
  const today = (offsetDays = 0) => ymd(new Date(Date.now() + TASHKENT_OFFSET_MS + offsetDays * 86_400_000));

  const show = async (ctx, text, keyboard) => {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard ?? {}) }); } catch (err) { if (!quiet(err)) throw err; }
  };

  async function token(ctx, edit = false) {
    try { return await tokens.getIdToken(ctx.from.id); } catch (err) {
      const msg = t(ctx.lang, err instanceof NotLinkedError ? 'postload_not_linked' : 'postload_session_error');
      await (edit ? show(ctx, msg) : ctx.reply(msg));
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ my trucks
  const card = (x, lang) => formatTruckMessage(x, lang);
  const route = (x) => `${x.locCity} → ${x.destPref}`;

  async function list(ctx) {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'myloads_dm_only')); return; }
    const idToken = await token(ctx);
    if (!idToken) return;
    let items;
    try { ({ items } = await apiClient.listMyTrucks(idToken)); } catch { await ctx.reply(t(ctx.lang, 'postload_unreachable')); return; }
    if (!items.length) { await ctx.reply(t(ctx.lang, 'mytr_empty')); return; }
    const sent = [(await ctx.reply(t(ctx.lang, 'mytr_header', { count: items.length })))?.message_id];
    for (const x of items.slice(0, MAX_CARDS)) sent.push((await ctx.reply(card(x, ctx.lang), { parse_mode: 'HTML', ...truckKeyboard(ctx.lang, x.id) }))?.message_id);
    if (items.length > MAX_CARDS) await ctx.reply(t(ctx.lang, 'myloads_more', { n: items.length - MAX_CARDS }));
    if (cleaner) {
      const key = cleaner.register({ userId: ctx.from.id, chatId: ctx.chat.id, msgIds: sent });
      await ctx.reply('🧹', Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'chat_clear_btn'), `chat:clear:${key}`)]]));
    }
  }

  async function withTruck(ctx, id, fn) {
    await ctx.answerCbQuery().catch(() => {});
    const idToken = await token(ctx, true);
    if (!idToken) return;
    let x;
    try { x = (await apiClient.listMyTrucks(idToken)).items.find((it) => it.id === Number(id)); } catch { await show(ctx, t(ctx.lang, 'postload_unreachable')); return; }
    if (!x) { await show(ctx, t(ctx.lang, 'mytr_gone')); return; }
    await fn(idToken, x);
  }
  const askDelete = (ctx, id) => withTruck(ctx, id, (_tok, x) => show(ctx, `${card(x, ctx.lang)}\n\n⚠️ ${t(ctx.lang, 'mytr_confirm')}`, Markup.inlineKeyboard([
    [Markup.button.callback(t(ctx.lang, 'myloads_btn_yes'), `mytr:del:${x.id}`), Markup.button.callback(t(ctx.lang, 'myloads_btn_no'), `mytr:card:${x.id}`)],
  ])));
  const showCard = (ctx, id) => withTruck(ctx, id, (_tok, x) => show(ctx, card(x, ctx.lang), truckKeyboard(ctx.lang, x.id)));
  const confirmDelete = (ctx, id) => withTruck(ctx, id, async (idToken, x) => {
    try {
      await apiClient.deleteTruck(idToken, x.id);
      await show(ctx, t(ctx.lang, 'mytr_deleted_named', { route: escapeHtml(route(x)) }));
    } catch { await show(ctx, t(ctx.lang, 'myloads_delete_failed')); }
  });
  const renew = (ctx, id) => withTruck(ctx, id, async (idToken, x) => {
    try {
      const fresh = await apiClient.renewTruck(idToken, x.id);
      await show(ctx, `${card(fresh, ctx.lang)}\n\n${t(ctx.lang, 'myloads_renewed')}`, truckKeyboard(ctx.lang, x.id));
    } catch { await show(ctx, `${card(x, ctx.lang)}\n\n${t(ctx.lang, 'myloads_renew_failed')}`, truckKeyboard(ctx.lang, x.id)); }
  });

  // ------------------------------------------------------------------------------------------------ posting
  const liveFlow = (ctx) => {
    const f = ctx.session?.ptr;
    if (f && Date.now() - f.at > FLOW_TTL_MS) { delete ctx.session.ptr; return null; }
    return f ?? null;
  };
  const endAll = (ctx) => { if (ctx.session) { delete ctx.session.ptr; delete ctx.session.trpaste; } };

  /** The menu button / command. */
  async function start(ctx) {
    if (ctx.chat.type !== 'private') { await ctx.reply(t(ctx.lang, 'postload_dm_only')); return; }
    const m = await loadMember(ctx);
    if (!m) return;
    endAll(ctx);
    const saved = m.member.myTruck;
    const rows = [];
    if (saved) rows.push([Markup.button.callback(t(ctx.lang, 'ptr_btn_saved', { type: t(ctx.lang, `eq_${saved.equip}`), cap: saved.capacityT }), 'ptr:go:saved')]);
    rows.push([Markup.button.callback(t(ctx.lang, 'ptr_btn_step'), 'ptr:go:new')]);
    rows.push([Markup.button.callback(t(ctx.lang, 'ptr_btn_ai'), 'ptr:ai')]);
    await ctx.reply(t(ctx.lang, saved ? 'ptr_intro_saved' : 'ptr_intro'), Markup.inlineKeyboard(rows));
  }

  /** `saved`: start from the saved truck; otherwise from nothing. */
  async function begin(ctx, mode) {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const m = await loadMember(ctx);
    if (!m) return;
    const saved = mode === 'saved' ? m.member.myTruck : null;
    if (mode === 'saved' && !saved) { await ctx.reply(t(ctx.lang, 'mt_none')); return; }
    endAll(ctx);
    ctx.session.ptr = {
      at: Date.now(), step: null, done: [], options: {},
      member: { company: m.member.company, phone: m.member.phone || '', telegram: m.member.telegram || '' },
      data: saved ? {
        equip: saved.equip, capacityT: saved.capacityT, volumeM3: saved.volumeM3 ?? null, hasTir: saved.hasTir, hasAdr: saved.hasAdr, hasGps: saved.hasGps,
        sideLoading: saved.sideLoading, notes: saved.notes || '', locCityId: saved.locCityId ?? null, locCity: saved.locCity || '', destPref: saved.destPref || '', fromSaved: true,
      } : { hasTir: false, hasAdr: false, hasGps: false, sideLoading: false, volumeM3: null, notes: '', destPref: '' },
    };
    await next(ctx);
  }

  const have = (f, step) => (step === 'equip' ? Boolean(f.data.equip) : step === 'cap' ? Boolean(f.data.capacityT) : f.done.includes(step));

  async function next(ctx) {
    const f = ctx.session.ptr;
    const step = STEPS.find((s) => !have(f, s));
    f.step = step ?? 'confirm';
    f.at = Date.now();
    const lang = ctx.lang;
    switch (f.step) {
      case 'equip':
        await ctx.reply(t(lang, 'ptr_ask_equip'), Markup.inlineKeyboard([
          ...[0, 2, 4].map((i) => EQUIP.slice(i, i + 2).map((c) => Markup.button.callback(t(lang, `eq_${c}`), `ptr:eq:${c}`))),
          [Markup.button.callback(t(lang, 'paste_btn_cancel'), 'ptr:cancel')],
        ]));
        break;
      case 'cap': await ctx.reply(t(lang, 'ptr_ask_cap')); break;
      case 'loc':
        await ctx.reply(t(lang, 'ptr_ask_loc'), Markup.inlineKeyboard([
          ...(f.data.locCityId ? [[Markup.button.callback(`📍 ${f.data.locCity}`, 'ptr:loc:keep')]] : []),
          [Markup.button.callback(t(lang, 'paste_btn_cancel'), 'ptr:cancel')],
        ]));
        break;
      case 'date':
        await ctx.reply(t(lang, 'ptr_ask_date'), Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'ptr_today'), 'ptr:date:0'), Markup.button.callback(t(lang, 'ptr_tomorrow'), 'ptr:date:1')],
          [Markup.button.callback(t(lang, 'paste_btn_cancel'), 'ptr:cancel')],
        ]));
        break;
      case 'dest':
        await ctx.reply(t(lang, 'ptr_ask_dest'), Markup.inlineKeyboard([
          [Markup.button.callback(t(lang, 'msg_anywhere'), 'ptr:dest:any'), ...(f.data.destPref && !/^any/i.test(f.data.destPref) ? [Markup.button.callback(`🏁 ${f.data.destPref.slice(0, 30)}`, 'ptr:dest:saved')] : [])],
          [Markup.button.callback(t(lang, 'paste_btn_cancel'), 'ptr:cancel')],
        ]));
        break;
      default: await preview(ctx);
    }
  }

  const bodyOf = (f) => ({
    locCityId: f.data.locCityId, destPref: f.data.destPref || 'Anywhere', equip: f.data.equip, capacityT: Number(f.data.capacityT), volumeM3: f.data.volumeM3 ?? null,
    availableFrom: f.data.availableFrom, availableTo: null, minRateUsd: null,
    hasTir: Boolean(f.data.hasTir), hasAdr: Boolean(f.data.hasAdr), hasGps: Boolean(f.data.hasGps), sideLoading: Boolean(f.data.sideLoading),
    notes: f.data.notes || '', contactPhone: f.member.phone, contactTelegram: f.member.telegram,
  });

  async function preview(ctx) {
    const f = ctx.session.ptr;
    const b = bodyOf(f);
    const text = formatTruckMessage({ ...b, locCity: f.data.locCity, company: f.member.company }, ctx.lang);
    await ctx.reply(`${text}\n\n<i>${t(ctx.lang, 'ptr_preview_footer')}</i>`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'ptr_btn_publish'), 'ptr:ok'), Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), 'ptr:cancel')]]),
    });
  }

  /** A button of the flow: runs `fn(f)` when the flow is still alive, otherwise says it expired. */
  async function flowAction(ctx, fn) {
    await ctx.answerCbQuery().catch(() => {});
    const f = liveFlow(ctx);
    if (!f) { await ctx.reply(t(ctx.lang, 'ptr_expired')); return; }
    await ctx.editMessageReplyMarkup?.({ inline_keyboard: [] }).catch(() => {});
    await fn(f);
  }

  const chooseEquip = (ctx, code) => flowAction(ctx, async (f) => { if (EQUIP.includes(code)) f.data.equip = code; await next(ctx); });
  const keepLoc = (ctx) => flowAction(ctx, async (f) => { f.done.push('loc'); await next(ctx); });
  const chooseDate = (ctx, offset) => flowAction(ctx, async (f) => { f.data.availableFrom = today(Number(offset)); f.done.push('date'); await next(ctx); });
  const chooseDest = (ctx, which) => flowAction(ctx, async (f) => {
    if (which === 'any') f.data.destPref = '';
    f.done.push('dest');
    await next(ctx);
  });
  const chooseCity = (ctx, id) => flowAction(ctx, async (f) => {
    const label = f.options[id];
    if (!label) { await ctx.reply(t(ctx.lang, 'edit_city_expired')); return; }
    f.data.locCityId = Number(id); f.data.locCity = label;
    f.done.push('loc');
    await next(ctx);
  });
  const cancel = async (ctx) => {
    await ctx.answerCbQuery?.().catch(() => {});
    endAll(ctx);
    await ctx.editMessageReplyMarkup?.({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply(t(ctx.lang, 'ptr_cancelled'));
  };

  const failText = (ctx, err) => {
    if (err instanceof ApiError && err.code === 'subscription_required') return t(ctx.lang, 'paste_subscription_required');
    if (err instanceof ApiError && err.status === 400) return t(ctx.lang, 'edit_invalid', { why: err.details?.length ? err.details.map((d) => `${d.path}: ${d.code}`).join(', ') : err.message });
    if (err instanceof ApiError && err.status === 429) return t(ctx.lang, 'ptr_too_many');
    return t(ctx.lang, 'postload_unreachable');
  };

  const publish = (ctx) => flowAction(ctx, async (f) => {
    const idToken = await token(ctx);
    if (!idToken) return;
    try {
      const posted = await apiClient.createTruck(idToken, bodyOf(f));
      endAll(ctx);
      const rows = truckKeyboard(ctx.lang, posted.id).reply_markup.inline_keyboard;
      const offerSave = !f.data.fromSaved;
      await ctx.reply(`${card(posted, ctx.lang)}\n\n${t(ctx.lang, 'ptr_published')}`, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([...rows, ...(offerSave ? [[Markup.button.callback(t(ctx.lang, 'ptr_btn_save_mine'), `ptr:save:${posted.id}`)]] : [])]),
      });
    } catch (err) {
      if (!(err instanceof ApiError)) log.error?.(`truck post failed: ${err.message}`);
      await ctx.reply(failText(ctx, err));
    }
  });

  /** «Save as my truck» under a truck that was just posted: the type, size and features become the saved truck. */
  async function saveAsMine(ctx, id) {
    await ctx.answerCbQuery().catch(() => {});
    const idToken = await token(ctx);
    if (!idToken) return;
    try {
      const x = (await apiClient.listMyTrucks(idToken)).items.find((it) => it.id === Number(id));
      if (!x) { await ctx.reply(t(ctx.lang, 'mytr_gone')); return; }
      await apiClient.putMyTruck(idToken, { equip: x.equip, capacityT: x.capacityT, volumeM3: x.volumeM3, hasTir: x.hasTir, hasAdr: x.hasAdr, hasGps: x.hasGps, sideLoading: x.sideLoading, locCityId: x.locCityId, destPref: x.destPref && !/^any/i.test(x.destPref) ? x.destPref : '' });
      await ctx.editMessageReplyMarkup?.({ inline_keyboard: truckKeyboard(ctx.lang, x.id).reply_markup.inline_keyboard }).catch(() => {});
      await ctx.reply(t(ctx.lang, 'ptr_saved_mine'));
    } catch (err) { await ctx.reply(failText(ctx, err)); }
  }

  // ------------------------------------------------------------------------------------------------ AI: describe the trucks
  async function askAi(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.editMessageReplyMarkup?.({ inline_keyboard: [] }).catch(() => {});
    endAll(ctx);
    ctx.session.trpaste = { at: Date.now() };
    await ctx.reply(t(ctx.lang, 'ptr_ai_howto'));
  }

  const parseKey = (err) => (err instanceof ApiError
    ? ({ ai_unavailable: 'paste_ai_unavailable', ai_busy: 'paste_ai_busy', ai_limit: 'paste_ai_limit', quota_exceeded: 'paste_ai_busy', ai_bad_output: 'paste_bad_output', subscription_required: 'paste_subscription_required' }[err.code] ?? 'paste_unreachable')
    : 'paste_unreachable');

  async function flush(userId) {
    const buf = pasteBuf.get(userId);
    if (!buf) return;
    pasteBuf.delete(userId);
    const { ctx } = buf;
    const text = buf.texts.join('\n\n');
    const edit = (msg) => ctx.telegram.editMessageText(ctx.chat.id, buf.waitId, undefined, msg).catch(() => ctx.reply(msg));
    let m;
    try { m = await loadMember(ctx); } catch { m = null; }
    if (!m) { await ctx.telegram.deleteMessage(ctx.chat.id, buf.waitId).catch(() => {}); return; }
    let res;
    try { res = await apiClient.parseTrucks(m.idToken, text); } catch (err) {
      await edit(t(ctx.lang, parseKey(err), err instanceof ApiError ? (err.details?.find((d) => d.code === 'ai_limit')?.params ?? {}) : {}));
      return;
    }
    const saved = m.member.myTruck;
    const drafts = (res.trucks ?? []).slice(0, MAX_REVIEW).map((d) => {
      const x = { ...d, flags: [...(d.flags ?? [])] };
      if (!x.locCityId && saved?.locCityId) { x.locCityId = saved.locCityId; x.locCity = saved.locCity; x.flags = x.flags.filter((fl) => fl !== 'location'); } // no place in the post: the usual one
      if (x.flags.includes('capacity') && saved?.capacityT) { x.capacityT = saved.capacityT; x.flags = x.flags.filter((fl) => fl !== 'capacity'); }
      if (!x.contactPhone && !x.contactTelegram) { x.contactPhone = m.member.phone || ''; x.contactTelegram = m.member.telegram || ''; }
      return x;
    });
    if (!drafts.length) { await edit(t(ctx.lang, 'ptr_ai_none')); return; }
    const review = { id: Math.random().toString(36).slice(2, 8), drafts, member: m.member, chatId: ctx.chat.id, at: Date.now(), msgId: buf.waitId };
    reviews.set(userId, review);
    const over = (res.trucks?.length ?? 0) - drafts.length;
    await edit(t(ctx.lang, 'ptr_ai_reading_done', { count: drafts.length }));
    review.msgId = null;
    await sendReview(ctx, review, over > 0 ? t(ctx.lang, 'paste_batch_full', { max: MAX_REVIEW, n: over }) : '');
  }

  const postable = (d) => !d.removed && Boolean(d.locCityId);

  function reviewView(ctx, review, extra = '') {
    const lang = ctx.lang;
    const blocks = review.drafts.map((d, i) => (d.removed ? `<s>#${i + 1}</s>` : formatTruckDraft(d, i + 1, lang)));
    const n = review.drafts.filter(postable).length;
    const text = [t(lang, 'ptr_review_header', { count: review.drafts.length }), ...(extra ? [extra] : []), '', blocks.join('\n\n'), '', `<i>${t(lang, 'ptr_review_hint')}</i>`].join('\n');
    const toggles = review.drafts.map((d, i) => Markup.button.callback(d.removed ? `↩️ #${i + 1}` : `🗑 #${i + 1}`, `trp:${d.removed ? 'back' : 'rm'}:${review.id}:${i}`));
    const rows = [];
    for (let i = 0; i < toggles.length; i += 5) rows.push(toggles.slice(i, i + 5));
    rows.push([
      ...(n ? [Markup.button.callback(t(lang, 'ptr_btn_publish_n', { n }), `trp:ok:${review.id}`)] : []),
      Markup.button.callback(t(lang, 'paste_btn_cancel'), `trp:cancel:${review.id}`),
    ]);
    return { text, keyboard: Markup.inlineKeyboard(rows) };
  }

  async function sendReview(ctx, review, extra = '') {
    const v = reviewView(ctx, review, extra);
    const sent = await withRetry(() => ctx.reply(v.text, { parse_mode: 'HTML', ...v.keyboard }), { sleep });
    review.msgId = sent?.message_id;
  }

  const reviewOf = (ctx, id) => { const r = reviews.get(ctx.from.id); return r && r.id === id && Date.now() - r.at < 60 * 60_000 ? r : null; };

  async function toggleDraft(ctx, id, i, removed) {
    await ctx.answerCbQuery().catch(() => {});
    const review = reviewOf(ctx, id);
    if (!review || !review.drafts[Number(i)]) { await show(ctx, t(ctx.lang, 'paste_expired')); return; }
    review.drafts[Number(i)].removed = removed;
    const v = reviewView(ctx, review);
    await show(ctx, v.text, v.keyboard);
  }

  async function publishReview(ctx, id) {
    await ctx.answerCbQuery().catch(() => {});
    const review = reviewOf(ctx, id);
    if (!review) { await show(ctx, t(ctx.lang, 'paste_expired')); return; }
    const picked = review.drafts.filter(postable);
    if (!picked.length) return;
    reviews.delete(ctx.from.id); // the first tap wins: a second tap finds nothing to post twice
    const idToken = await token(ctx, true);
    if (!idToken) return;
    const bodies = picked.map((d) => ({
      locCityId: d.locCityId, destPref: d.destPref || 'Anywhere', equip: d.equip, capacityT: Number(d.capacityT), volumeM3: d.volumeM3 ?? null,
      availableFrom: d.availableFrom, availableTo: d.availableTo ?? null, minRateUsd: d.minRateUsd ?? null,
      hasTir: Boolean(d.hasTir), hasAdr: Boolean(d.hasAdr), hasGps: Boolean(d.hasGps), sideLoading: Boolean(d.sideLoading),
      notes: d.notes || '', contactPhone: d.contactPhone || '', contactTelegram: d.contactTelegram || '',
    }));
    try {
      const { items } = await apiClient.createTrucksBulk(idToken, bodies);
      await show(ctx, t(ctx.lang, 'ptr_posted_summary', { count: items.length }));
      const ids = [];
      for (const x of items) {
        const sent = await withRetry(() => ctx.reply(card(x, ctx.lang), { parse_mode: 'HTML', ...truckKeyboard(ctx.lang, x.id) }), { sleep });
        ids.push(sent?.message_id);
        if ((config.draftGapMs ?? 300) > 0) await sleep(config.draftGapMs ?? 300);
      }
      if (cleaner) {
        const key = cleaner.register({ userId: ctx.from.id, chatId: ctx.chat.id, msgIds: [review.msgId, ...ids] });
        await ctx.reply('🧹', Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'chat_clear_btn'), `chat:clear:${key}`)]]));
      }
    } catch (err) {
      reviews.set(ctx.from.id, review); // nothing was posted: the review stays so the person can try again
      if (!(err instanceof ApiError)) log.error?.(`truck bulk post failed: ${err.message}`);
      await show(ctx, failText(ctx, err), reviewView(ctx, review).keyboard);
    }
  }

  async function cancelReview(ctx, id) {
    await ctx.answerCbQuery().catch(() => {});
    if (reviewOf(ctx, id)) reviews.delete(ctx.from.id);
    await show(ctx, t(ctx.lang, 'ptr_cancelled'));
  }

  // ------------------------------------------------------------------------------------------------ typed answers
  /** A plain text message: returns true when it belonged to a truck dialogue. */
  async function handleText(ctx) {
    const text = ctx.message.text.trim();
    const f = liveFlow(ctx);
    if (f) {
      if (f.step === 'cap') {
        const p = parseEditValue('cap', text);
        if (!p) { await ctx.reply(t(ctx.lang, 'edit_invalid', { why: t(ctx.lang, 'edit_invalid_format') })); return true; }
        f.data.capacityT = p.capacityT;
        await next(ctx);
        return true;
      }
      if (f.step === 'loc') {
        const idToken = await token(ctx);
        if (!idToken) return true;
        let items = [];
        try { ({ items } = await apiClient.searchCities(idToken, text, 6)); } catch { await ctx.reply(t(ctx.lang, 'postload_unreachable')); return true; }
        if (!items.length) { await ctx.reply(t(ctx.lang, 'edit_city_none')); return true; }
        f.options = Object.fromEntries(items.map((c) => [c.id, c.label]));
        await ctx.reply(t(ctx.lang, 'edit_city_pick'), Markup.inlineKeyboard(items.map((c) => [Markup.button.callback(c.label, `ptr:city:${c.id}`)])));
        return true;
      }
      if (f.step === 'date') {
        const d = parseDate(text);
        if (!d || d < today(-1)) { await ctx.reply(t(ctx.lang, 'edit_invalid', { why: t(ctx.lang, 'edit_invalid_format') })); return true; }
        f.data.availableFrom = d; f.done.push('date');
        await next(ctx);
        return true;
      }
      if (f.step === 'dest') {
        if (text.length > 120) { await ctx.reply(t(ctx.lang, 'edit_invalid', { why: t(ctx.lang, 'edit_invalid_format') })); return true; }
        f.data.destPref = text; f.done.push('dest');
        await next(ctx);
        return true;
      }
      await ctx.reply(t(ctx.lang, 'ptr_use_buttons')); // equip / confirm are answered with the buttons - never read as a pasted load post
      return true;
    }
    const paste = ctx.session?.trpaste;
    if (paste) {
      if (Date.now() - paste.at > FLOW_TTL_MS) { delete ctx.session.trpaste; return false; }
      if (text.length < 8) { await ctx.reply(t(ctx.lang, 'paste_too_short')); return true; }
      paste.at = Date.now();
      let buf = pasteBuf.get(ctx.from.id);
      if (!buf) {
        buf = { texts: [], ctx, timer: null, waitId: (await ctx.reply(t(ctx.lang, 'paste_parsing')))?.message_id };
        pasteBuf.set(ctx.from.id, buf);
      }
      buf.ctx = ctx;
      buf.texts.push(text);
      clearTimeout(buf.timer);
      const ms = config.pasteDebounceMs ?? 2500;
      if (ms > 0) { buf.timer = setTimeout(() => flush(ctx.from.id).catch((err) => log.error?.(`truck paste failed: ${err.message}`)), ms); buf.timer.unref?.(); } else await flush(ctx.from.id);
      return true;
    }
    return false;
  }

  return {
    list, showCard, askDelete, confirmDelete, renew,
    start, begin, askAi, chooseEquip, keepLoc, chooseDate, chooseDest, chooseCity, publish, cancel, saveAsMine,
    toggleDraft, publishReview, cancelReview, handleText, endAll,
  };
}
