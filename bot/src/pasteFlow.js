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
import { escapeHtml, formatDraftBlock, formatPostedLine, isDraftPostable } from './format.js';
import { t } from './i18n.js';

const MAX_TELEGRAM_MESSAGE = 3500; // stay well under Telegram's 4096-char limit with HTML entities
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

// contactPhone/contactTelegram/contactName are REQUIRED by loadBody (server/src/lib/schemas.js: a
// phone OR a Telegram username, either one). A pasted group post often has neither - exactly the
// gap the web app's AI-import screen fills with the posting member's own profile ("default contact
// info"). We do the same here with the linked member's profile.
export function toLoadBody(draft, member) {
  const estimated = draft.flags?.length ? ` · auto-import: ${draft.flags.join(', ')} estimated - confirm by phone` : '';
  const notes = `${draft.notes || ''}${estimated}`.trim().slice(0, 500);
  return {
    originCityId: draft.originCityId,
    destCityId: draft.destCityId,
    equip: draft.equip,
    fp: draft.fp,
    weightT: draft.weightT,
    volumeM3: draft.volumeM3 ?? undefined,
    pickupDate: draft.pickupDate,
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

/** Splits one long message into chunks that stay under Telegram's length limit, joined on blank lines. */
function chunkBlocks(blocks, max = MAX_TELEGRAM_MESSAGE) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const b of blocks) {
    if (cur.length && len + b.length + 2 > max) { chunks.push(cur.join('\n\n')); cur = []; len = 0; }
    cur.push(b);
    len += b.length + 2;
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

export function makePasteFlow({ apiClient, tokens, config, log = console }) {
  const rateLimiter = makeRateLimiter(config.aiMaxPerMin);
  const pending = new Map(); // telegramUserId -> { nonce, drafts, member, createdAt }
  const ttlMs = config.pendingTtlMin * 60_000;

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

  async function handleText(ctx) {
    if (ctx.chat.type !== 'private') return; // never read group chatter, only this member's own DM
    const text = ctx.message.text.trim();
    if (text.length < MIN_PASTE_CHARS) return; // too short to be a load post - say nothing, avoid noise

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

    const postable = loads.filter(isDraftPostable).length;
    const nonce = randomUUID();
    pending.set(ctx.from.id, { nonce, drafts: loads, member, createdAt: Date.now() });

    const blocks = loads.map((d, i) => formatDraftBlock(d, i + 1, ctx.lang));
    const header = t(ctx.lang, 'paste_found_header', { count: loads.length }) + (truncated ? `\n${t(ctx.lang, 'paste_truncated_note', { max: loads.length })}` : '');
    const chunks = chunkBlocks(blocks);
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, header).catch(() => {});
    for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: 'HTML' });

    const skipped = loads.length - postable;
    let footer = t(ctx.lang, 'paste_ready_footer', { postable, total: loads.length });
    if (skipped > 0) footer += t(ctx.lang, 'paste_skip_note', { count: skipped });
    const keyboard = postable > 0
      ? Markup.inlineKeyboard([
          [Markup.button.callback(t(ctx.lang, 'paste_btn_post', { count: postable }), `paste:confirm:${nonce}`)],
          [Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), `paste:cancel:${nonce}`)],
        ])
      : Markup.inlineKeyboard([[Markup.button.callback(t(ctx.lang, 'paste_btn_cancel'), `paste:cancel:${nonce}`)]]);
    return ctx.reply(footer, { parse_mode: 'HTML', ...keyboard });
  }

  function takePending(ctx, nonce) {
    const entry = pending.get(ctx.from.id);
    if (!entry || entry.nonce !== nonce) return null;
    if (Date.now() - entry.createdAt > ttlMs) { pending.delete(ctx.from.id); return null; }
    return entry;
  }

  async function handleConfirm(ctx, nonce) {
    await ctx.answerCbQuery();
    const entry = takePending(ctx, nonce);
    if (!entry) return ctx.editMessageText(t(ctx.lang, 'paste_expired'));
    pending.delete(ctx.from.id);

    const { drafts, member } = entry;
    const postableDrafts = drafts.filter(isDraftPostable);
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
      const plural = ctx.lang === 'en' && items.length !== 1 ? 's' : '';
      const lines = [t(ctx.lang, 'paste_posted_header', { count: items.length, plural })];
      for (const row of items) lines.push(formatPostedLine(row, ctx.lang, config.webBaseUrl, config.webUrlIsPublic));
      const skipped = drafts.length - postableDrafts.length;
      if (skipped > 0) lines.push(t(ctx.lang, 'paste_skip_note', { count: skipped }).trim());
      return ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML' });
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
    if (takePending(ctx, nonce)) pending.delete(ctx.from.id);
    return ctx.editMessageText(t(ctx.lang, 'paste_cancelled'));
  }

  return { handleText, handleConfirm, handleCancel };
}
