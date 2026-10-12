// Phone numbers as truckers actually write them in chat groups: "+998 97 924 24 00", "979242400", "97 924 2400", "97924 24 00",
// even "9 7 9 2 4 2 4 0 0", "8 (903) 123-45-67", with 🔥 or flags around them and no country code at all (a local Uzbek number is
// just 9 digits). Everything is turned into one canonical "+<country code><number>" so the board, the bot and the contact buttons
// all see the same thing. Pure functions, no I/O.

// 9 digits that start with one of these are an Uzbek number without the +998 (mobile 33 50 55 77 88 9x ..., fixed-line 6x 7x).
const UZ_FIRST = /^[3567-9]/;
// Country codes whose full numbers are 12 digits long (CC + 9) in the region this board serves.
const CC12 = /^(998|996|992|993|994|995|374|373|375|380|370|371|372)/;

/** One written-out phone number -> "+998979242400", or "" when it is not a plausible phone number. */
export function normalizePhone(raw) {
  const text = String(raw ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7) return '';
  if (text.startsWith('+') || text.startsWith('00')) {
    const d = text.startsWith('00') ? digits.slice(2) : digits;
    return d.length >= 8 && d.length <= 15 ? `+${d}` : '';
  }
  if (digits.length === 9) return UZ_FIRST.test(digits) ? `+998${digits}` : '';
  if (digits.length === 10) {
    if (digits.startsWith('0') && UZ_FIRST.test(digits.slice(1))) return `+998${digits.slice(1)}`; // 0 97 924 24 00
    return digits.startsWith('9') ? `+7${digits}` : ''; // Russian / Kazakh mobile without the 7 / 8
  }
  if (digits.length === 11 && /^[78]/.test(digits)) return `+7${digits.slice(1)}`; // 8 903 ... / 7 903 ...
  if (digits.length === 12 && CC12.test(digits)) return `+${digits}`;
  return '';
}

// A run of digits on ONE line, joined by single separators (spaces, dots, dashes, brackets) - never across a line break.
const RUN = /\+?\d(?:[ \t().\-–—]{0,2}\d){6,14}/g;

/** Every phone number written in `text`, in order: { raw, phone (normalised), index }. Dates, weights and prices are not mistaken for phones. */
export function findPhones(text) {
  const found = [];
  for (const m of String(text ?? '').matchAll(RUN)) {
    const before = text[m.index - 1];
    if (before && /[\d]/.test(before)) continue;
    // a date (12.10.2026, 2026-10-12) or a time is not a phone number
    if (/^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}$/.test(m[0].trim())) continue;
    const phone = normalizePhone(m[0]);
    if (phone) found.push({ raw: m[0].trim(), phone, index: m.index });
  }
  return found;
}

/** The distinct canonical numbers in a text. */
export const distinctPhones = (text) => [...new Set(findPhones(text).map((p) => p.phone))];
