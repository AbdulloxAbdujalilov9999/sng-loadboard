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
function makeRateLimiter(perMinute, burst = 6) {
  // A bucket that holds `burst` reads: a big paste cut into pieces starts them together, while a steady stream is still held to
  // `perMinute` (the server has its own hourly budget per member).
  const gapMs = 60_000 / Math.max(1, perMinute);
  let virtual = 0;
  return async function throttle() {
    const now = Date.now();
    virtual = Math.max(virtual, now - burst * gapMs) + gapMs;
    const wait = virtual - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

// Only guesses that could mislead a reader. A missing rate already reads "Kelishiladi" on the board, so it is not repeated.
const GUESSED_UZ = { weight: 'ogʻirlik', date: 'sana', origin_check: 'yuklash joyi', dest_check: 'yetkazish joyi' };

// contactPhone/contactTelegram/contactName are REQUIRED by loadBody (server/src/lib/schemas.js: a
// phone OR a Telegram username, either one). A pasted group post often has neither - exactly the
// gap the web app's AI-import screen fills with the posting member's own profile ("default contact
// info"). We do the same here with the linked member's profile.
//
// `contactMode` is the member's answer to "whose contact goes on these loads?" when the pasted post carries someone else's:
//   'mine' - every load shows the member's own contact;
//   'keep' - every load keeps the contact written in the post; a load without one gets the contact the other loads of the same
//            paste carry (`common`), so the person who wrote the post is reachable on all of them. The member's profile is only
//            used when nobody put a contact in the post.
// Without an answer (nothing foreign in the post) a missing contact falls back to the member's, as before.
export function toLoadBody(draft, member, { contactMode, common } = {}) {
  // The note is shown to everyone on the board, and the board's own language is Uzbek.
  const guessed = (draft.flags ?? []).map((f) => GUESSED_UZ[f]).filter(Boolean);
  const estimated = guessed.length ? ` · Taxminiy: ${guessed.join(', ')} — telefon orqali aniqlang` : '';
  const notes = `${draft.notes || ''}${estimated}`.trim().slice(0, 500);
  // The board refuses a pickup date from before yesterday - and one such load would stop the whole batch. A post that says "ready"
  // with an old date is meant for today.
  const utcDay = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  const pickupDate = draft.pickupDate && draft.pickupDate < utcDay(-1) ? utcDay(0) : draft.pickupDate;
  return {
    originCityId: draft.originCityId,
    destCityId: draft.destCityId,
    equip: draft.equip,
    fp: draft.fp,
    weightT: draft.weightT,
    volumeM3: draft.volumeM3 ?? undefined,
    pickupDate,
    deliveryDate: draft.deliveryDate && draft.deliveryDate >= pickupDate ? draft.deliveryDate : undefined,
    rateUsd: draft.rateUsd,
    commodity: draft.commodity,
    notes: notes || undefined,
    ...contactFields(draft, member, contactMode, common),
    contactEmail: member.contactEmail || '',
  };
}

function contactFields(draft, member, mode, common) {
  const mineName = member.contactName || member.company || '';
  const own = Boolean(draft.contactPhone || draft.contactTelegram);
  if (mode === 'mine' && (member.phone || member.telegram)) {
    return { contactName: mineName || draft.contactName || '-', contactPhone: member.phone || '', contactTelegram: member.telegram || '' };
  }
  if (mode === 'keep') {
    const src = own ? draft : (common ?? (member.phone || member.telegram ? { contactName: mineName, contactPhone: member.phone, contactTelegram: member.telegram } : draft));
    return { contactName: draft.contactName || src.contactName || mineName || '-', contactPhone: src.contactPhone || '', contactTelegram: src.contactTelegram || '' };
  }
  return {
    contactName: draft.contactName || mineName || '-',
    contactPhone: draft.contactPhone || member.phone || '',
    contactTelegram: draft.contactTelegram || member.telegram || '',
  };
}

// ---- whose contact? ----
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const handle = (v) => String(v ?? '').replace(/^@/, '').toLowerCase();
/** The contacts written in the pasted posts that are not the member's own, with how many loads carry each. */
export function foreignContacts(drafts, member) {
  const found = new Map();
  for (const d of drafts) {
    if (!d.contactPhone && !d.contactTelegram) continue;
    const samePhone = !d.contactPhone || (member.phone && digits(d.contactPhone) === digits(member.phone));
    const sameTg = !d.contactTelegram || (member.telegram && handle(d.contactTelegram) === handle(member.telegram));
    if (samePhone && sameTg) continue;
    const key = `${digits(d.contactPhone)}|${handle(d.contactTelegram)}`;
    const cur = found.get(key) ?? { contactName: d.contactName || '', contactPhone: d.contactPhone || '', contactTelegram: d.contactTelegram || '', count: 0 };
    cur.count += 1;
    found.set(key, cur);
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}
/** The contact most of the loads in this paste carry - given to the loads that came without one when the member keeps the post's contact. */
export function commonContact(drafts) {
  const count = new Map();
  for (const d of drafts) {
    if (!d.contactPhone && !d.contactTelegram) continue;
    const key = `${digits(d.contactPhone)}|${handle(d.contactTelegram)}`;
    const cur = count.get(key) ?? { contactName: d.contactName || '', contactPhone: d.contactPhone || '', contactTelegram: d.contactTelegram || '', n: 0 };
    cur.n += 1;
    count.set(key, cur);
  }
  return [...count.values()].sort((a, b) => b.n - a.n)[0] ?? null;
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
  const MAX_BATCH = 50; // loads in one review = loads one Post tap publishes (the API's bulk limit)
  const draftGapMs = config.draftGapMs ?? 0; // pause between the messages of a big batch (the tests use 0)
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // Telegram answers 429 "retry after N seconds" when a chat is flooded: wait exactly that long and try again.
  async function withRetry(fn) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await fn(); } catch (err) {
        if (err?.response?.error_code !== 429 || attempt >= 8) throw err;
        await sleep(Math.min(Number(err.response.parameters?.retry_after ?? 3), 60) * 1000 + 300);
      }
    }
  }

  // One read at a time per person, so two pastes close together cannot interleave their messages.
  const chains = new Map();
  function serial(userId, fn) {
    const run = (chains.get(userId) ?? Promise.resolve()).catch(() => {}).then(fn);
    chains.set(userId, run);
    run.finally(() => { if (chains.get(userId) === run) chains.delete(userId); }).catch(() => {});
    return run;
  }

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
  function openEntry(userId) {
    const m = pending.get(userId);
    if (!m) return null;
    for (const entry of [...m.values()].reverse()) { if (entryFor(userId, batchOf(entry.nonce))) return entry; }
    return null;
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

  const countPostable = (entry) => entry.drafts.filter((d) => !d.removed && !d.posted && isDraftPostable(d)).length;

  function footerView(ctx, entry) {
    const live = entry.drafts.filter((d) => !d.removed && !d.posted);
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
  async function clearButtons(ctx, entry, only = () => true) {
    for (let i = 0; i < entry.msgIds.length; i += 1) {
      if (!entry.msgIds[i] || !only(entry.drafts[i])) continue;
      await withRetry(() => ctx.telegram.editMessageReplyMarkup?.(entry.chatId, entry.msgIds[i], undefined, { inline_keyboard: [] })).catch(() => {});
      if (draftGapMs > 0) await sleep(Math.round(draftGapMs / 3));
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

  // A big paste (many forwarded posts) is cut at blank lines into pieces of about CHUNK_CHARS and the pieces are read at the same time:
  // 50 loads take about as long as 12 would, instead of one long wait for a single huge answer.
  const CHUNK_CHARS = 2500;
  const PARALLEL_READS = 3;
  function splitIntoChunks(text) {
    if (text.length <= CHUNK_CHARS * 1.4) return [text];
    const pieces = text.split(/\n\s*\n/).flatMap((block) => (block.length <= CHUNK_CHARS ? [block] : block.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}(?:\\n|$)`, 'g')) ?? [block]));
    const chunks = [];
    let cur = '';
    for (const piece of pieces) {
      if (cur && cur.length + piece.length + 2 > CHUNK_CHARS) { chunks.push(cur); cur = ''; }
      cur = cur ? `${cur}\n\n${piece}` : piece;
    }
    if (cur) chunks.push(cur);
    return chunks;
  }
  async function parseAll(idToken, text) {
    const chunks = splitIntoChunks(text);
    const results = new Array(chunks.length);
    let next = 0;
    async function worker() {
      while (next < chunks.length) {
        const i = next; next += 1;
        try { await rateLimiter(); results[i] = { ok: await apiClient.parseLoads(idToken, chunks[i]) }; } catch (err) { results[i] = { err }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_READS, chunks.length) }, worker));
    const good = results.filter((r) => r.ok);
    if (!good.length) throw results[0].err;
    return {
      loads: good.flatMap((r) => r.ok.loads), truncated: good.some((r) => r.ok.truncated),
      unread: results.length - good.length, // pieces the AI could not read (busy / limit): the rest still goes on
    };
  }

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

  const readPaste = (ctx, text) => serial(ctx.from.id, () => readPasteNow(ctx, text));

  async function readPasteNow(ctx, text) {
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
    let loads, truncated, unread;
    try {
      ({ loads, truncated, unread } = await parseAll(idToken, text));
    } catch (err) {
      const key = err instanceof ApiError
        ? ({ ai_unavailable: 'paste_ai_unavailable', ai_busy: 'paste_ai_busy', ai_limit: 'paste_ai_limit', quota_exceeded: 'paste_ai_busy', ai_bad_output: 'paste_bad_output' }[err.code] ?? 'paste_unreachable')
        : 'paste_unreachable';
      const vars = err instanceof ApiError ? (err.details?.find((d) => d.code === 'ai_limit')?.params ?? {}) : {};
      const msg = t(ctx.lang, key, vars);
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, msg).catch(() => ctx.reply(msg));
      return undefined;
    }

    if (!loads.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, t(ctx.lang, 'paste_no_loads_found')).catch(() => {});
      return undefined;
    }

    // Everything pasted while a review is open joins that same review, so there is always ONE Post button at the bottom, whatever
    // the number of messages forwarded or loads in them. (After Post / Cancel, or when it expired, the next paste starts a new one.)
    let entry = openEntry(ctx.from.id);
    const fresh = !entry;
    if (fresh) {
      entry = { nonce: randomUUID(), drafts: [], member, createdAt: Date.now(), chatId: ctx.chat.id, msgIds: [], footerMsgId: null };
      addEntry(ctx.from.id, entry);
    }
    entry.member = member;
    entry.contactChoice = null; // new posts may carry a new contact: ask again at Post
    const room = Math.max(0, MAX_BATCH - entry.drafts.length);
    const incoming = loads.slice(0, room);
    const overflow = loads.length - incoming.length;
    const firstIdx = entry.drafts.length;
    entry.drafts.push(...incoming.map((d) => ({ ...d })));

    const notes = [];
    if (truncated) notes.push(t(ctx.lang, 'paste_truncated_note', { max: loads.length }));
    if (unread) notes.push(t(ctx.lang, 'paste_chunk_failed', { n: unread }));
    if (overflow > 0) notes.push(t(ctx.lang, 'paste_batch_full', { max: MAX_BATCH, n: overflow }));
    const title = fresh ? t(ctx.lang, 'paste_found_header', { count: incoming.length }) : t(ctx.lang, 'paste_added_header', { added: incoming.length, total: entry.drafts.length });
    const slow = incoming.length > 10 ? `\n${t(ctx.lang, 'paste_showing')}` : '';
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, [title, ...notes, t(ctx.lang, 'paste_review_hint')].join('\n') + slow).catch(() => {});
    // Each load is its own message, so each can be edited or removed on its own. Telegram allows about one message a second to a chat,
    // so a big batch is sent at an even pace, and a "slow down" answer (429) is waited out instead of losing the rest of the batch.
    for (let i = firstIdx; i < entry.drafts.length; i += 1) {
      const v = draftView(ctx, entry, i);
      const sent = await withRetry(() => ctx.reply(v.text, { parse_mode: 'HTML', ...v.keyboard }));
      entry.msgIds.push(sent?.message_id);
      if (draftGapMs > 0) await sleep(draftGapMs);
    }
    // The one Post message always sits at the very bottom: the old one (if any) is replaced.
    if (entry.footerMsgId) await ctx.telegram.deleteMessage(entry.chatId, entry.footerMsgId).catch(() => {});
    const f = footerView(ctx, entry);
    const footer = await withRetry(() => ctx.reply(f.text, { parse_mode: 'HTML', ...f.keyboard }));
    entry.footerMsgId = footer?.message_id;
    return undefined;
  }

  function takePending(ctx, nonce) {
    const entry = entryFor(ctx.from.id, batchOf(nonce));
    return entry && entry.nonce === nonce ? entry : null;
  }

  // Which drafts the API refused: details look like { path: "loads.3.pickupDate", code: "pickup_past" }.
  const failingIndexes = (err) => {
    const idx = new Map();
    for (const d of err?.details ?? []) {
      const m = /^loads\.(\d+)(?:\.|$)/.exec(d.path ?? '');
      if (m) idx.set(Number(m[1]), [...(idx.get(Number(m[1])) ?? []), d]);
    }
    return idx;
  };
  const reasonOf = (ctx, details) => details.map((d) => {
    const key = `bulk_reason_${d.code}`;
    const text = t(ctx.lang, key);
    return text === key ? (d.message || d.code) : text;
  }).join(', ');

  // The post carries somebody else's contact (a forwarded post): before anything is published, ask whose contact the loads show.
  async function askContact(ctx, entry, foreign) {
    const mine = [entry.member.phone, entry.member.telegram].filter(Boolean).join(' · ') || '-';
    const list = foreign.slice(0, 5).map((c) => `• ${escapeHtml([c.contactName, c.contactPhone, c.contactTelegram].filter(Boolean).join(' · '))} - ${t(ctx.lang, 'paste_contact_count', { n: c.count })}`).join('\n');
    const nonce = entry.nonce;
    return ctx.reply(t(ctx.lang, 'paste_contact_ask', { list, mine: escapeHtml(mine) }), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(t(ctx.lang, 'paste_contact_btn_mine'), `paste:contact:${nonce}:mine`)],
        [Markup.button.callback(t(ctx.lang, 'paste_contact_btn_keep'), `paste:contact:${nonce}:keep`)],
        [Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), `paste:contact:${nonce}:back`)],
      ]),
    });
  }

  async function handleContactChoice(ctx, nonce, choice) {
    await ctx.answerCbQuery();
    const entry = takePending(ctx, nonce);
    if (!entry) return ctx.editMessageText(t(ctx.lang, 'paste_expired'));
    if (choice === 'back') return ctx.editMessageText(t(ctx.lang, 'paste_contact_back'));
    if (choice !== 'mine' && choice !== 'keep') return undefined;
    entry.contactChoice = choice;
    if (entry.posting) return undefined;
    entry.posting = true;
    try { return await postBatch(ctx, entry); } finally { entry.posting = false; }
  }

  // The answer goes on the message that was tapped; when that was the contact question (not the Post message at the bottom), the
  // bottom message shows it too - otherwise its Post button would stay there, looking untouched.
  async function showResult(ctx, entry, text, keyboard) {
    const tapped = ctx.callbackQuery?.message?.message_id;
    if (tapped && entry.footerMsgId && tapped !== entry.footerMsgId) {
      await ctx.editMessageText(text.split('\n')[0] || text, { parse_mode: 'HTML' }).catch(() => {});
      return ctx.telegram.editMessageText(entry.chatId, entry.footerMsgId, undefined, text, { parse_mode: 'HTML', ...(keyboard ?? {}) }).catch(() => {});
    }
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard ?? {}) });
  }

  async function handleConfirm(ctx, nonce) {
    await ctx.answerCbQuery();
    const entry = takePending(ctx, nonce);
    if (!entry) return ctx.editMessageText(t(ctx.lang, 'paste_expired'));
    if (entry.posting) return undefined; // a second tap while the first is still posting
    entry.posting = true;
    try { return await postBatch(ctx, entry); } finally { entry.posting = false; }
  }

  // Posts everything that is ready. One refused load never stops the others: the board is told again without it, and the refused ones
  // stay in the review (with their reason) to be fixed and posted. The review is only closed once nothing is left to fix.
  async function postBatch(ctx, entry) {
    const { drafts, member } = entry;
    const live = drafts.filter((d) => !d.removed && !d.posted);
    let postable = live.filter(isDraftPostable);
    if (!postable.length) return ctx.editMessageText(t(ctx.lang, 'paste_nothing_postable'));
    const foreign = entry.contactChoice ? [] : foreignContacts(postable, member);
    if (foreign.length) return askContact(ctx, entry, foreign);
    if (postable.some((d) => !hasContact(d, member))) return ctx.editMessageText(t(ctx.lang, 'paste_contact_missing'));

    let idToken;
    try {
      idToken = await tokens.getIdToken(ctx.from.id);
    } catch {
      return ctx.editMessageText(t(ctx.lang, 'paste_session_error'));
    }

    const refused = []; // { draft, why }
    let postedCount = 0;
    try {
      for (let round = 0; round < 3 && postable.length; round += 1) {
        try {
          const common = entry.contactChoice === 'keep' ? commonContact(live) : null;
          const { items } = await apiClient.createLoadsBulk(idToken, postable.map((d) => toLoadBody(d, member, { contactMode: entry.contactChoice, common })));
          postable.forEach((d) => { d.posted = true; });
          postedCount += items.length;
          postable = [];
        } catch (err) {
          const bad = err instanceof ApiError && err.status === 400 ? failingIndexes(err) : new Map();
          if (!bad.size) throw err;
          for (const [i, details] of bad) if (postable[i]) refused.push({ draft: postable[i], why: reasonOf(ctx, details) });
          postable = postable.filter((_, i) => !bad.has(i));
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'subscription_required') return ctx.editMessageText(t(ctx.lang, 'paste_subscription_required'));
      if (err instanceof ApiError) {
        const detail = err.details?.length ? `\n${err.details.map((d) => `• ${d.path}: ${d.code}`).join('\n')}` : '';
        return ctx.editMessageText(t(ctx.lang, 'paste_post_failed', { message: escapeHtml(err.message) + escapeHtml(detail) })); // the review stays: try again
      }
      log.error?.(`paste bulk post failed: ${err.message}`);
      return ctx.editMessageText(t(ctx.lang, 'paste_post_failed_generic'));
    }

    // The buttons of what is posted come off in the background (50 edits take a few seconds); the answer does not wait for them.
    clearButtons(ctx, entry, (d) => d?.posted).catch(() => {});
    const lines = [];
    if (postedCount) lines.push(t(ctx.lang, 'paste_posted_summary', { count: postedCount })); // every load follows as its own message from the broadcaster
    if (refused.length) {
      lines.push(t(ctx.lang, 'bulk_failed_header', { n: refused.length }));
      for (const { draft, why } of refused) lines.push(`• #${drafts.indexOf(draft) + 1} ${escapeHtml(routeOf(draft))} - ${escapeHtml(why)}`);
      const f = footerView(ctx, entry);
      return showResult(ctx, entry, `${lines.join('\n')}\n${f.text}`, f.keyboard);
    }
    dropEntry(ctx.from.id, entry);
    const skipped = live.length - postedCount;
    if (skipped > 0) lines.push(t(ctx.lang, 'paste_skip_note', { count: skipped }).trim());
    return showResult(ctx, entry, lines.join('\n\n'), null);
  }

  async function handleCancel(ctx, nonce) {
    await ctx.answerCbQuery();
    const entry = takePending(ctx, nonce);
    if (entry) { dropEntry(ctx.from.id, entry); clearButtons(ctx, entry).catch(() => {}); }
    return ctx.editMessageText(t(ctx.lang, 'paste_cancelled'));
  }

  return { handleText, handleConfirm, handleContactChoice, handleCancel, handleRemove, handleUndo, draftAdapter };
}
