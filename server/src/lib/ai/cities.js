// Maps free-text place names (Russian Cyrillic, Uzbek Latin/Cyrillic, English) onto our city list.
// The AI is asked to pick a label from the list; this module VERIFIES that choice and, when the AI gave
// none (or an invented one), falls back to fuzzy matching so a typo-level difference still resolves.

const RU_TO_LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Uzbek Cyrillic extras
  ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h',
};

/** Lower-case, strip flags/punctuation, and bring Cyrillic + Latin spellings to one comparable Latin form. */
export function fold(text) {
  let s = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, ''); // й -> и + mark: fix below
  s = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu, ' ');           // flag + other emoji
  s = [...s].map((ch) => (RU_TO_LAT[ch] !== undefined ? RU_TO_LAT[ch] : ch)).join('');
  s = s.replace(/[ʻʼ'`’‘]/g, '').replace(/[^a-z0-9\s-]/g, ' ');
  // Uzbek-Latin / English / Russian spelling variants -> one form
  s = s.replace(/kh/g, 'h').replace(/x/g, 'h').replace(/q/g, 'k').replace(/w/g, 'v').replace(/yo/g, 'e')
    .replace(/sch/g, 'sh').replace(/ts/g, 's').replace(/[oa]/g, 'a').replace(/y/g, 'i').replace(/j/g, 'zh').replace(/(.)\1+/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

function distance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export function buildCityIndex(cities) {
  return {
    cities,
    byLabel: new Map(cities.map((c) => [c.label.toLowerCase(), c])),
    folded: cities.map((c) => ({ city: c, keys: [...new Set([fold(c.name), fold(c.name_ru)])] })),
  };
}

/**
 * Resolve one place. `label` = the AI's pick from our list (verified); `text` = the place as written.
 * Returns { city, how } or { city: null }.  how: 'label' | 'exact' | 'fuzzy'
 */
export function resolveCity(index, { label, text } = {}) {
  if (label) {
    const hit = index.byLabel.get(String(label).trim().toLowerCase());
    if (hit) return { city: hit, how: 'label' };
  }
  // Try the whole text, then each word (so "ТОМСК АСИНО" can still land on Томск when the AI fails).
  const whole = fold(text);
  const candidates = whole ? [whole, ...whole.split(' ').filter((w) => w.length >= 3)] : [];
  for (const cand of candidates) {
    const exact = index.folded.filter((e) => e.keys.includes(cand));
    if (exact.length === 1) return { city: exact[0].city, how: 'exact' };
  }
  for (const cand of candidates) {
    const cap = cand.length >= 8 ? 2 : cand.length >= 5 ? 1 : 0;
    if (!cap) continue;
    let best = null; let bestD = cap + 1; let tie = false;
    for (const e of index.folded) {
      const d = Math.min(...e.keys.map((k) => distance(cand, k, cap)));
      if (d < bestD) { best = e.city; bestD = d; tie = false; } else if (d === bestD && best && e.city.id !== best.id) tie = true;
    }
    if (best && !tie) return { city: best, how: 'fuzzy' };
  }
  return { city: null, how: null };
}
