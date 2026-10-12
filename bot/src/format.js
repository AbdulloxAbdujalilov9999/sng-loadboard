// Turns a `loads` row (same snake_case shape server/src/routes/loads.js inserts/returns) into the
// message broadcast to every group, and into the confirmation preview shown inside /postload.
// Pure functions - no I/O - so they're covered by bot/test without a database or Telegram.
import { t } from './i18n.js';

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A rate of 0 means "not stated / negotiable" (the web board shows it the same way), never "$0".
export const money = (n, lang = 'en') => (n === null || n === undefined ? '-' : Number(n) === 0 ? t(lang, 'msg_negotiable') : `$${Number(n).toLocaleString('en-US')}`);

// The free-text note is often several short facts joined with " · " or on separate lines ("Без перегруза · Груз готов ✅ ·
// Срочно 🚀"): show them as a list. A segment that starts with "Taxminiy:" is the AI's own warning that it guessed
// something (pasteFlow.js writes it) - that goes on its own line, in italics, apart from what the sender wrote.
export function formatNotes(notes, lang = 'en') {
  const parts = String(notes ?? '').split(/\s*(?:·|\n|;)\s*/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return [];
  const guess = parts.filter((x) => /^taxminiy:/i.test(x));
  const own = parts.filter((x) => !/^taxminiy:/i.test(x));
  const lines = [];
  if (own.length === 1) lines.push(`📝 ${escapeHtml(own[0])}`);
  else if (own.length > 1) lines.push(`📝 ${t(lang, 'msg_notes_header')}`, ...own.map((x) => `• ${escapeHtml(x)}`));
  for (const g of guess) lines.push(`⚠️ <i>${escapeHtml(g)}</i>`);
  return lines;
}

/** A load as the API returns it (camelCase, /api/loads/mine) turned into the `loads` row shape the formatters above use. */
export const dtoToRow = (l) => ({
  id: l.id, origin_city: l.originCity, dest_city: l.destCity, equip: l.equip, fp: l.fp, weight_t: l.weightT, volume_m3: l.volumeM3,
  pickup_date: l.pickupDate, delivery_date: l.deliveryDate, distance_km: l.distanceKm, rate_usd: l.rateUsd, commodity: l.commodity,
  notes: l.notes, company_name: l.company, contact_name: l.contactName, contact_phone: l.contactPhone, contact_email: l.contactEmail,
  contact_tg: l.contactTelegram,
});

/** `linkUrl`, when given, becomes a "view on the loadboard" line - see bot/src/broadcaster.js. */
export function formatLoadMessage(row, lang = 'en', linkUrl = null) {
  const equip = t(lang, `eq_${row.equip}`);
  const fp = t(lang, row.fp === 'Full' ? 'wiz_fp_full' : 'wiz_fp_partial');
  const pickup = row.delivery_date
    ? t(lang, 'msg_pickup_delivery', { date: row.pickup_date, date2: row.delivery_date })
    : t(lang, 'msg_pickup', { date: row.pickup_date });
  // One fact per line (each tagged by its own emoji, no label text to translate) - easier to scan
  // in a group chat than a paragraph.
  const lines = [
    `🚚 <b>${escapeHtml(row.origin_city)} → ${escapeHtml(row.dest_city)}</b>`,
    '',
    `🔧 ${equip} · ${fp}`,
    `⚖️ ${Number(row.weight_t)} t${row.volume_m3 ? ` · ${row.volume_m3} m³` : ''}`,
    `📦 ${escapeHtml(row.commodity)}`,
    `📅 ${pickup}`,
  ];
  if (row.distance_km) lines.push(`📏 ${row.distance_km} km`);
  lines.push(`💰 ${money(row.rate_usd, lang)}`);
  const notes = formatNotes(row.notes, lang);
  if (notes.length) lines.push('', ...notes);
  lines.push('');
  // Company and contact name are often the same person/one-person company - show it once, not twice.
  const name = row.company_name && row.company_name !== row.contact_name
    ? `${row.company_name} (${row.contact_name})`
    : (row.contact_name || row.company_name);
  if (name) lines.push(`👤 ${escapeHtml(name)}`);
  if (row.contact_phone) lines.push(`📞 ${escapeHtml(row.contact_phone)}`);
  const tgLine = [row.contact_tg, row.contact_email].filter(Boolean).map(escapeHtml);
  if (tgLine.length) lines.push(`✈️ ${tgLine.join(' · ')}`);
  if (linkUrl) lines.push('', `<a href="${escapeHtml(linkUrl)}">${t(lang, 'msg_view_on_board')}</a>`);
  return lines.join('\n');
}

export function formatLoadPreview(row, lang = 'en') {
  return `${formatLoadMessage(row, lang)}\n\n<i>${t(lang, 'wiz_preview_footer')}</i>`;
}

/**
 * Our own official channel/group, as a line (or two) to append to the welcome message, the
 * /postload confirmation, and every broadcast message - see bot.js, wizard.js and broadcaster.js.
 * `config` is bot config (`joinChannel`/`joinGroup`, see config.js) - both optional, so this is ''
 * (append nothing) when neither is set.
 */
export function joinLines(config, lang = 'en') {
  const at = (handle) => `@${String(handle).replace(/^@/, '')}`; // config.js already strips "@" - also guard here against a bare "@handle" passed directly
  const lines = [];
  if (config.joinChannel) lines.push(t(lang, 'join_channel', { handle: at(config.joinChannel) }));
  if (config.joinGroup) lines.push(t(lang, 'join_group', { handle: at(config.joinGroup) }));
  return lines.join('\n');
}

// ---- AI paste-import review messages (pasteFlow.js) ----
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
  lines.push(`🔧 ${t(lang, `eq_${draft.equip}`)} (${t(lang, draft.fp === 'Partial' ? 'wiz_fp_partial' : 'wiz_fp_full')})`
    + ` · ⚖️ ${Number(draft.weightT)} t${draft.volumeM3 ? ` · ${draft.volumeM3} m³` : ''}`);
  lines.push(`📦 ${escapeHtml(draft.commodity)}`);
  lines.push(`📅 ${draft.pickupDate}${draft.deliveryDate ? ` → ${draft.deliveryDate}` : ''} · 💰 ${money(draft.rateUsd, lang)}`);
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
