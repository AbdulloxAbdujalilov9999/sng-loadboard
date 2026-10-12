// Turns an AI-parsed load draft (the shape POST /api/ai/parse-loads returns - see
// sng-loadboard/server/src/routes/ai.js) into the review message shown before posting, and a
// created load (POST /api/loads/bulk's response, same camelCase shape) into the confirmation line
// after posting. Pure functions - no I/O - so they're covered by test/format.test.js without a
// database or Telegram.
import { t } from './i18n.js';

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A rate of 0 means "not stated / negotiable" (the web board shows it the same way), never "$0".
export const money = (n, lang = 'en') => (n === null || n === undefined ? '-' : Number(n) === 0 ? t(lang, 'negotiable') : `$${Number(n).toLocaleString('en-US')}`);

const FLAG_ORDER = ['origin', 'dest', 'same_city', 'origin_check', 'dest_check', 'weight', 'date', 'rate'];
// Flags that mean "could not resolve a city" - these drafts are excluded from the bulk post
// (the API would reject the whole batch otherwise) and listed separately so the member can fix the
// wording and paste that one load again, or use the other bot's /postload for it.
const BLOCKING_FLAGS = new Set(['origin', 'dest', 'same_city']);

/** Whether a parsed draft has everything POST /api/loads/bulk needs to accept it. */
export function isDraftPostable(draft) {
  return Boolean(draft.originCityId) && Boolean(draft.destCityId) && draft.originCityId !== draft.destCityId;
}

function flagText(lang, flag) {
  const key = `flag_${flag}`;
  const s = t(lang, key);
  return s === key ? null : s; // unknown flag code: say nothing rather than show a raw key
}

/** One numbered block per parsed draft, with amber-flag warnings spelled out - the chat equivalent
 * of the web app's AI-import review screen. */
export function formatDraftBlock(draft, idx, lang = 'en') {
  const postable = isDraftPostable(draft);
  const origin = draft.originCity || draft.originText || '?';
  const dest = draft.destCity || draft.destText || '?';
  const mark = postable ? '' : '🚫 ';
  const lines = [`<b>#${idx} ${mark}${escapeHtml(origin)} → ${escapeHtml(dest)}</b>`];
  lines.push(`🔧 ${t(lang, `eq_${draft.equip}`)} (${t(lang, draft.fp === 'Partial' ? 'fp_partial' : 'fp_full')})`
    + ` · ⚖️ ${Number(draft.weightT)} t${draft.volumeM3 ? ` · ${draft.volumeM3} m³` : ''}`);
  lines.push(`📦 ${escapeHtml(draft.commodity)}`);
  lines.push(`📅 ${draft.pickupDate} · 💰 ${money(draft.rateUsd, lang)}`);
  if (draft.notes) lines.push(`📝 ${escapeHtml(draft.notes)}`);
  const contact = [draft.contactName, draft.contactPhone, draft.contactTelegram].filter(Boolean).map(escapeHtml);
  if (contact.length) lines.push(`☎️ ${contact.join(' · ')}`);
  const flags = (draft.flags ?? []).filter((f) => FLAG_ORDER.includes(f)).sort((a, b) => FLAG_ORDER.indexOf(a) - FLAG_ORDER.indexOf(b));
  const blocking = flags.filter((f) => BLOCKING_FLAGS.has(f)).map((f) => flagText(lang, f)).filter(Boolean);
  const warnings = flags.filter((f) => !BLOCKING_FLAGS.has(f)).map((f) => flagText(lang, f)).filter(Boolean);
  if (blocking.length) lines.push(`🚫 <i>${blocking.join(' · ')}</i>`);
  if (warnings.length) lines.push(`⚠️ <i>${warnings.join(' · ')}</i>`);
  return lines.join('\n');
}

/** One line per posted load in the final confirmation message, with its own "view on the board" link. */
export function formatPostedLine(row, lang, webBaseUrl, webUrlIsPublic) {
  const rate = money(row.rateUsd, lang);
  const base = `${escapeHtml(row.originCity)} → ${escapeHtml(row.destCity)} · ${row.pickupDate} · ${rate}`;
  if (!webUrlIsPublic) return `• ${base}`;
  const link = `${webBaseUrl}/?load=${row.id}`;
  return `• <a href="${escapeHtml(link)}">${base}</a>`;
}
