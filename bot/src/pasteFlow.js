// The core of this bot: turn a pasted/forwarded freight post into reviewed, posted loads.
//
//   paste text -> AI parse (same /api/ai/parse-loads the web app's import screen calls)
//              -> show each draft, flag anything uncertain, exclude anything unresolved
//              -> member taps Post -> POST /api/loads/bulk (all-or-nothing) under their own account
//
// No load is ever built or inserted here directly - createLoadsBulk is the exact same door
// server/src/routes/loads.js guards for everyone else, so quotas, city validation and every CHECK
// constraint apply exactly as they do to a load typed by hand on the web app.
import { randomUUID } from 'node:crypto';
import { Markup } from 'telegraf';
import { ApiError } from './apiClient.js';
import { NotLinkedError } from './tokens.js';
import { escapeHtml, formatDraftBlock, isDraftPostable } from './format.js';
import { t } from './i18n.js';

const MIN_PASTE_CHARS = 8; // matches server/src/routes/ai.js's own minimum - shorter can't be a load

// Spaces out AI calls to a fixed rate, independent of how many people paste at once - keeps this
// process well under the server's per-member hourly AI budget and Gemini's own rate limits.
function makeRateLimiter(perMinute) {
  const minGapMs = 60_000 / Math.max(1, perMinute);
  let next = 0;
  return async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minGapMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

// Only guesses that could mislead a reader. A missing rate already reads "Kelishiladi" on the board, so it is not repeated.
const GUESSED_UZ = { weight: 'ogʻirlik', date: 'sana', origin_check: 'yuklash joyi', dest_check: 'yetkazish joyi' };

// contactPhone/contactTelegram/contactName are REQUIRED by loadBody (server/src/lib/schemas.js: a
// phone OR a Telegram username, either one). A pasted group post often has neither - exactly the
// gap the web app's AI-import screen fills with the posting member's own profile ("default contact
// info"). We do the same here with the linked member's profile.
export function toLoadBody(draft, member) {
  // The note is shown to everyone on the board, and the board's own language is Uzbek.
  const guessed = (draft.flags ?? []).map((f) => GUESSED_UZ[f]).filter(Boolean);
  const estimated = guessed.length ? ` · Taxminiy: ${guessed.join(', ')} — telefon orqali aniqlang` : '';
  const notes = `${draft.notes || ''}${estimated}`.trim().slice(0, 500);
  return {
    originCityId: draft.originCityId,
    destCityId: draft.destCityId,
    equip: draft.equip,
    fp: draft.fp,
    weightT: draft.weightT,
    volumeM3: draft.volumeM3 ?? undefined,
    pickupDate: draft.pickupDate,
    deliveryDate: draft.deliveryDate || undefined,
    rateUsd: draft.rateUsd,
    commodity: draft.commodity,
    notes: notes || undefined,
    contactName: draft.contactName || member.contactName || member.company || '-',
    contactPhone: draft.contactPhone || member.phone || '',
    contactEmail: member.contactEmail || '',
    contactTelegram: draft.contactTelegram || member.telegram || '',
  };
}

const hasContact = (draft, member) => Boolean(draft.contactPhone || draft.contactTelegram || member.phone || member.telegram);

// What editing a field of a draft changes in the draft's own warnings: a field the member just fixed is no longer a guess.
const FLAGS_CLEARED_BY = {
  originCityId: ['origin', 'origin_check', 'same_city'], destCityId: ['dest', 'dest_check', 'same_city'],
  weightT: ['weight'], pickupDate: ['date'], rateUsd: ['rate'],
};

export function applyDraftPatch(draft, patch) {
  Object.assign(draft, patch);
  const fixed = Object.keys(patch).flatMap((k) => FLAGS_CLEARED_BY[k] ?? []);
  draft.flags = (draft.flags ?? []).filter((f) => !fixed.includes(f));
  if (draft.originCityId && draft.originCityId === draft.destCityId && !draft.flags.includes('same_city')) draft.flags.push('same_city');
}

const batchOf = (nonce) => nonce.slice(0, 8);
const routeOf = (d) => `${d.originCity || d.originText || '?'} → ${d.destCity || d.destText || '?'}`;

export function makePasteFlow({ apiClient, tokens, config, log = console }) {
  const rateLimiter = makeRateLimiter(config.aiMaxPerMin);
  // telegramUserId -> (batch -> { nonce, drafts, member, createdAt, chatId, msgIds[], footerMsgId }). A person can have several open
  // reviews at once (the Post button of an earlier paste keeps working when they paste again); the oldest is dropped past MAX_OPEN.
  const pending = new Map();
  const ttlMs = config.pendingTtlMin * 60_000;
  const MAX_OPEN = 5;
  // Forwarding several posts at once sends one Telegram message each, a moment apart: they are collected for this long (after the
  // last one) and read as ONE paste - one review, one Post button. 0 = no waiting (used by the tests).
  const debounceMs = config.pasteDebounceMs ?? 0;
  const MAX_COLLECT_MS = 8000;
  const collecting = new Map(); // telegramUserId -> { texts, ctx, timer, since }
  const MAX_PASTE_CHARS = 12000; // the API's own limit for one text

  function addEntry(userId, entry) {
    const m = pending.get(userId) ?? new Map();
    pending.set(userId, m);
    m.set(batchOf(entry.nonce), entry);
    while (m.size > MAX_OPEN) m.delete(m.keys().next().value);
  }
  function dropEntry(userId, entry) {
    const m = pending.get(userId);
    m?.delete(batchOf(entry.nonce));
    if (m && !m.size) pending.delete(userId);
  }
  function entryFor(userId, batch) {
    const entry = pending.get(userId)?.get(batch);
    if (!entry) return null;
    if (Date.now() - entry.createdAt > ttlMs) { dropEntry(userId, entry); return null; }
    return entry;
  }

  async function requireLinkedApproved(ctx) {
    const idToken = await tokens.getIdToken(ctx.from.id); // throws NotLinkedError
    const me = await apiClient.getMe(idToken);
    if (!me.profile || me.profile.status !== 'approved') {
      const err = new Error('not approved');
      err.notApproved = true;
      throw err;
    }
    return { idToken, member: me.profile };
  }

  // ---- one message per draft, each with its own Edit / Remove buttons ----
  function draftView(ctx, entry, idx) {
    const draft = entry.drafts[idx];
    const key = `${batchOf(entry.nonce)}.${idx}`;
    if (draft.removed) {
      return { text: t(ctx.lang, 'draft_removed', { route: escapeHtml(routeOf(draft)) }), keyboard: Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'draft_btn_undo'), `pd:undo:${key}`)]]) };
    }
    return {
      text: formatDraftBlock(draft, idx + 1, ctx.lang),
      keyboard: Markup.inlineKeyboard([[
        Markup.button.callback(t(ctx.lang, 'draft_btn_edit'), `ed:menu:D${key}`), Markup.button.callback(t(ctx.lang, 'draft_btn_remove'), `pd:rm:${key}`),
      ]]),
    };
  }

  const countPostable = (entry) => entry.drafts.filter((d) => !d.removed && isDraftPostable(d)).length;

  function footerView(ctx, entry) {
    const live = entry.drafts.filter((d) => !d.removed);
    const postable = countPostable(entry);
    const skipped = live.length - postable;
    let text = t(ctx.lang, 'paste_ready_footer', { postable, total: live.length });
    if (skipped > 0) text += t(ctx.lang, 'paste_skip_note', { count: skipped });
    const nonce = entry.nonce;
    const keyboard = postable > 0
      ? Markup.inlineKeyboard([
        [Markup.button.callback(t(ctx.lang, 'paste_btn_post', { count: postable }), `paste:confirm:${nonce}`)],
        [Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), `paste:cancel:${nonce}`)],
      ])
      : Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), `paste:cancel:${nonce}`)]]);
    return { text, keyboard };
  }

  // After any change the bottom message ("Ready to post N of M" + the Post button) shows the new counts.
  async function refreshFooter(ctx, entry) {
    if (!entry.footerMsgId) return;
    const v = footerView(ctx, entry);
    await ctx.telegram.editMessageText(entry.chatId, entry.footerMsgId, undefined, v.text, { parse_mode: 'HTML', ...v.keyboard }).catch(() => {});
  }

  // Once the batch is posted or cancelled the Edit / Remove buttons on its messages would act on nothing: take them away.
  async function clearButtons(ctx, entry) {
    for (const id of entry.msgIds) {
      await ctx.telegram.editMessageReplyMarkup?.(entry.chatId, id, undefined, { inline_keyboard: [] }).catch(() => {});
    }
  }

  /** How editor.js reads and changes a draft (target "D<batch>.<index>"). */
  const draftAdapter = {
    async load(ctx, ref) {
      const entry = entryFor(ctx.from.id, ref.batch);
      if (!entry || !entry.drafts[ref.idx]) {
        const msg = t(ctx.lang, 'paste_expired');
        if (ctx.callbackQuery) await ctx.editMessageText(msg).catch(() => {}); else await ctx.reply(msg);
        return null;
      }
      return { entry, idx: ref.idx };
    },
    view: (ctx, { entry, idx }) => draftView(ctx, entry, idx),
    async apply(ctx, _ref, item, patch, extra) {
      applyDraftPatch(item.entry.drafts[item.idx], { ...patch, ...extra });
      await refreshFooter(ctx, item.entry);
      return item;
    },
  };

  async function setRemoved(ctx, key, removed) {
    await ctx.answerCbQuery().catch(() => {});
    const [batch, i] = key.split('.');
    const entry = entryFor(ctx.from.id, batch);
    const idx = Number(i);
    if (!entry || !entry.drafts[idx]) return ctx.editMessageText(t(ctx.lang, 'paste_expired')).catch(() => {});
    entry.drafts[idx].removed = removed;
    const v = draftView(ctx, entry, idx);
    await ctx.editMessageText(v.text, { parse_mode: 'HTML', ...v.keyboard }).catch(() => {});
    return refreshFooter(ctx, entry);
  }
  const handleRemove = (ctx, key) => setRemoved(ctx, key, true);
  const handleUndo = (ctx, key) => setRemoved(ctx, key, false);

  // `textOverride` is the text after "/paste " when the member sends everything in one command.
  function handleText(ctx, textOverride) {
    if (ctx.chat.type !== 'private') return undefined; // never read group chatter, only this member's own DM
    const text = (textOverride ?? ctx.message.text).trim();
    if (debounceMs <= 0) return readPaste(ctx, text);
    const userId = ctx.from.id;
    const c = collecting.get(userId) ?? { texts: [], since: Date.now(), timer: null };
    collecting.set(userId, c);
    c.texts.push(text);
    c.ctx = ctx;
    clearTimeout(c.timer);
    const wait = Math.min(debounceMs, Math.max(0, MAX_COLLECT_MS - (Date.now() - c.since)));
    c.timer = setTimeout(() => {
      collecting.delete(userId);
      readPaste(c.ctx, c.texts.join('\n\n').slice(0, MAX_PASTE_CHARS)).catch((err) => {
        log.error?.(`paste failed: ${err.message}`);
        c.ctx.reply(t(c.ctx.lang, 'generic_error')).catch(() => {});
      });
    }, wait);
    return undefined;
  }

  async function readPaste(ctx, text) {
    if (text.length < MIN_PASTE_CHARS) return ctx.reply(t(ctx.lang, 'paste_too_short')); // not a load post: say how it works instead of staying silent

    let idToken, member;
    try {
      ({ idToken, member } = await requireLinkedApproved(ctx));
    } catch (err) {
      if (err instanceof NotLinkedError) return ctx.reply(t(ctx.lang, 'paste_not_linked'));
      if (err?.notApproved) return ctx.reply(t(ctx.lang, 'paste_not_approved'));
      return ctx.reply(t(ctx.lang, 'paste_unreachable'));
    }

    const waitMsg = await ctx.reply(t(ctx.lang, 'paste_parsing'));
    let loads, truncated;
    try {
      await rateLimiter();
      ({ loads, truncated } = await apiClient.parseLoads(idToken, text));
    } catch (err) {
      const key = err instanceof ApiError
        ? ({ ai_unavailable: 'paste_ai_unavailable', ai_busy: 'paste_ai_busy', quota_exceeded: 'paste_ai_busy', ai_bad_output: 'paste_bad_output' }[err.code] ?? 'paste_unreachable')
        : 'paste_unreachable';
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, t(ctx.lang, key)).catch(() => ctx.reply(t(ctx.lang, key)));
      return undefined;
    }

    if (!loads.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, t(ctx.lang, 'paste_no_loads_found')).catch(() => {});
      return undefined;
    }

    const nonce = randomUUID();
    const entry = { nonce, drafts: loads.map((d) => ({ ...d })), member, createdAt: Date.now(), chatId: ctx.chat.id, msgIds: [], footerMsgId: null };
    addEntry(ctx.from.id, entry);

    const header = `${t(ctx.lang, 'paste_found_header', { count: loads.length })}${truncated ? `\n${t(ctx.lang, 'paste_truncated_note', { max: loads.length })}` : ''}\n${t(ctx.lang, 'paste_review_hint')}`;
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, header).catch(() => {});
    // Each load is its own message, so each can be edited or removed on its own.
    for (let i = 0; i < entry.drafts.length; i += 1) {
      const v = draftView(ctx, entry, i);
      const sent = await ctx.reply(v.text, { parse_mode: 'HTML', ...v.keyboard });
      entry.msgIds.push(sent?.message_id);
    }
    const f = footerView(ctx, entry);
    const footer = await ctx.reply(f.text, { parse_mode: 'HTML', ...f.keyboard });
    entry.footerMsgId = footer?.message_id;
    return undefined;
  }

  function takePending(ctx, nonce) {
    const entry = entryFor(ctx.from.id, batchOf(nonce));
    return entry && entry.nonce === nonce ? entry : null;
  }

  async function handleConfirm(ctx, nonce) {
    await ctx.answerCbQuery();
    const entry = takePending(ctx, nonce);
    if (!entry) return ctx.editMessageText(t(ctx.lang, 'paste_expired'));
    dropEntry(ctx.from.id, entry);

    const { drafts, member } = entry;
    const live = drafts.filter((d) => !d.removed);
    const postableDrafts = live.filter(isDraftPostable);
    if (!postableDrafts.length) return ctx.editMessageText(t(ctx.lang, 'paste_nothing_postable'));
    if (postableDrafts.some((d) => !hasContact(d, member))) return ctx.editMessageText(t(ctx.lang, 'paste_contact_missing'));

    let idToken;
    try {
      idToken = await tokens.getIdToken(ctx.from.id);
    } catch {
      return ctx.editMessageText(t(ctx.lang, 'paste_session_error'));
    }

    try {
      const { items } = await apiClient.createLoadsBulk(idToken, postableDrafts.map((d) => toLoadBody(d, member)));
      await clearButtons(ctx, entry);
      // No list here: every posted load arrives as its own message (with Edit / Renew / Delete) from the broadcaster, right behind this one.
      const lines = [t(ctx.lang, 'paste_posted_summary', { count: items.length })];
      const skipped = live.length - postableDrafts.length;
      if (skipped > 0) lines.push(t(ctx.lang, 'paste_skip_note', { count: skipped }).trim());
      return ctx.editMessageText(lines.join('\n\n'), { parse_mode: 'HTML' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'subscription_required') return ctx.editMessageText(t(ctx.lang, 'paste_subscription_required'));
      if (err instanceof ApiError) {
        const detail = err.details?.length ? `\n${err.details.map((d) => `• ${d.path}: ${d.code}`).join('\n')}` : '';
        return ctx.editMessageText(t(ctx.lang, 'paste_post_failed', { message: escapeHtml(err.message) + escapeHtml(detail) }));
      }
      log.error?.(`paste bulk post failed: ${err.message}`);
      return ctx.editMessageText(t(ctx.lang, 'paste_post_failed_generic'));
    }
  }

  async function handleCancel(ctx, nonce) {
    await ctx.answerCbQuery();
    const entry = takePending(ctx, nonce);
    if (entry) { dropEntry(ctx.from.id, entry); await clearButtons(ctx, entry); }
    return ctx.editMessageText(t(ctx.lang, 'paste_cancelled'));
  }

  return { handleText, handleConfirm, handleCancel, handleRemove, handleUndo, draftAdapter };
}
