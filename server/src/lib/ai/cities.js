// One place that understands how people write cities: Russian Cyrillic, Uzbek Latin / Cyrillic, English, old and
// short names, regions ("Xorazm"), typos and Russian endings ("из Томска"). Used by
//   * the AI importers  - to turn what a message says into a real city on the board (resolveCity), and
//   * the city autocomplete - so typing "Xorazm" or "Ташкент" finds Urgench / Tashkent (searchCities).
// Everything is compared in a "folded" form: lower-case, one script, merged spelling variants.
import { NOISE_WORDS, REGION_ROWS } from './regions.js';

const RU_TO_LAT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  // Uzbek / Kazakh / Kyrgyz / Tajik Cyrillic extras
  ў: 'o', қ: 'q', ғ: 'g', ҳ: 'h', ә: 'a', ө: 'o', ү: 'u', ұ: 'u', і: 'i', ң: 'n', һ: 'h', ҷ: 'j', ӣ: 'i', ӯ: 'u',
};

/** Lower-case, strip flags/emoji/punctuation, bring Cyrillic + Latin spellings to ONE comparable Latin form. */
export function fold(text) {
  let s = String(text ?? '').toLowerCase().replace(/ё/g, 'е');
  s = s.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu, ' ');           // flag + other emoji
  s = [...s].map((ch) => (RU_TO_LAT[ch] !== undefined ? RU_TO_LAT[ch] : ch)).join('');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');                           // é, ü, İ ...
  s = s.replace(/[ʻʼ'`’‘ʿ]/g, '').replace(/[^a-z0-9\s-]/g, ' ');
  // Uzbek-Latin / English / Russian spelling variants -> one form
  s = s.replace(/dzh/g, 'zh').replace(/dj/g, 'zh').replace(/kh/g, 'h').replace(/x/g, 'h').replace(/q/g, 'k').replace(/w/g, 'v')
    .replace(/yo/g, 'e').replace(/sch/g, 'sh').replace(/ts/g, 's').replace(/[oa]/g, 'a').replace(/y/g, 'i').replace(/j/g, 'zh')
    .replace(/-/g, ' ').replace(/(.)\1+/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

function distance(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0];
    prev[0] = i;
    let rowMin = prev[0];
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
      if (prev[j] < rowMin) rowMin = prev[j];
    }
    if (rowMin > cap) return cap + 1;
  }
  return prev[b.length];
}

const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const splitAliases = (s) => String(s ?? '').split(/\s*;\s*/).filter(Boolean);

/** Builds the in-memory index from the `cities` table rows. ~2,000 cities: lookups take well under a millisecond. */
export function buildCityIndex(cities) {
  const entries = cities.map((city) => {
    const seen = new Map(); // folded key -> raw spelling (first one wins; the English name always comes first)
    for (const raw of [city.name, city.name_ru, ...splitAliases(city.aliases)]) { const key = fold(raw); if (key && !seen.has(key)) seen.set(key, raw); }
    return { city, keys: [...seen.keys()], raws: seen, pop: city.population ?? 0 };
  });
  const byFold = new Map(); // folded name -> entries, biggest town first
  for (const e of entries) for (const k of e.keys) { if (!byFold.has(k)) byFold.set(k, []); byFold.get(k).push(e); }
  for (const list of byFold.values()) list.sort((a, b) => b.pop - a.pop);

  const entryOf = new Map(entries.map((e) => [e.city.id, e]));
  const byLabel = new Map(cities.map((c) => [c.label.toLowerCase(), c]));

  // Regions -> the city that represents them. Capitals are found by NAME + country (see regions.js).
  const regions = new Map(); // folded region name -> { entry, region }
  for (const row of REGION_ROWS) {
    const hit = (byFold.get(fold(row.capital)) ?? []).find((e) => e.city.country === row.country);
    if (!hit) continue;
    for (const name of row.names) { const k = fold(name); if (k && !regions.has(k)) regions.set(k, { entry: hit, region: name }); }
  }
  return { cities, entries, byFold, byLabel, entryOf, regions };
}

const STOP = new Set([...NOISE_WORDS].map(fold));
const words = (text) => fold(text).split(' ').filter((w) => w && !STOP.has(w));

/** Candidate strings to try, most specific first: the whole text, then runs of words (longest first). */
function candidatesOf(text) {
  const w = words(text);
  if (!w.length) return [];
  const out = [w.join(' ')];
  for (let len = Math.min(w.length - 1, 3); len >= 1; len -= 1) {
    for (let i = 0; i + len <= w.length; i += 1) out.push(w.slice(i, i + len).join(' '));
  }
  return [...new Set(out)].filter((c) => c.length >= 2);
}

const pick = (entries, country) => {
  const same = country ? entries.filter((e) => e.city.country === country) : [];
  return (same.length ? same : entries)[0]; // already sorted by population
};

function fuzzy(index, cand, country) {
  const cap = cand.length >= 9 ? 2 : cand.length >= 5 ? 1 : 0;
  if (!cap) return null;
  let best = null; let bestD = cap + 1; let tie = false;
  for (const e of index.entries) {
    if (country && e.city.country !== country) continue;
    let d = cap + 1;
    // a match on the town's own name beats a match on an alias (old / alternate names such as "Samarkandskiy" for Temirtau)
    e.keys.forEach((k, idx) => { d = Math.min(d, distance(cand, k, cap) + (idx === 0 ? 0 : 0.5)); });
    if (d > cap) continue;
    if (d < bestD) { best = e; bestD = d; tie = false; }
    else if (d === bestD && e.city.id !== best.city.id) {
      // equally close: a clearly bigger town wins, otherwise it is ambiguous and we do not guess
      if (e.pop > best.pop * 5) { best = e; tie = false; } else if (!(best.pop > e.pop * 5)) tie = true;
    }
  }
  return best && !tie ? best : null;
}

/**
 * Resolve one place to a city.
 *   label   - a city label the model/user picked ("Tomsk, RU"): verified, never trusted
 *   text    - the place as written ("ТОМСК АСИНО", "Xorazm", "из Ташкента")
 *   country - ISO-2 when known (flag emoji / the model), restricts and ranks candidates
 *   lat/lng - approximate coordinates when known: the last resort is the nearest listed town
 * Returns { city, how } where how is one of label | exact | region | fuzzy | nearest (null city when nothing fits).
 */
export function resolveCity(index, { label, text, country, lat, lng } = {}) {
  const cc = country ? String(country).toUpperCase() : null;
  if (label) {
    const hit = index.byLabel.get(String(label).trim().toLowerCase());
    if (hit) return { city: hit, how: 'label' };
  }

  const cands = candidatesOf(text);
  // 1) exact folded match (names, aliases, Cyrillic names), 2) region name. A multi-word text such as
  //    "ТОМСК АСИНО" holds a region/main city AND the real town: the more specific (later) word wins when
  //    it is a real place near the first one.
  const hits = [];
  for (const cand of cands) {
    const exact = index.byFold.get(cand);
    // A region written in full ("Khorezm") means its capital, unless some town really is called that (then the town wins).
    const isTownName = exact?.some((e) => e.keys[0] === cand);
    if (index.regions.has(cand) && !isTownName) hits.push({ cand, entry: index.regions.get(cand).entry, how: 'region' });
    else if (exact) hits.push({ cand, entry: pick(exact, cc), how: 'exact' });
  }
  if (hits.length) {
    const whole = hits.find((h) => h.cand === cands[0]);
    if (whole) return { city: whole.entry.city, how: whole.how };
    // single words: prefer the LAST matching word if it is within ~400 km of the first (locality inside the region)
    const ordered = words(text);
    const pos = (h) => ordered.indexOf(h.cand.split(' ')[0]);
    const singles = hits.filter((h) => !h.cand.includes(' ')).sort((a, b) => pos(a) - pos(b));
    if (singles.length > 1) {
      const first = singles[0]; const last = singles[singles.length - 1];
      if (distanceKm(first.entry.city, last.entry.city) < 400) return { city: last.entry.city, how: last.how };
    }
    const h = singles[0] ?? hits[0];
    return { city: h.entry.city, how: h.how };
  }

  // 3) typos / endings ("Томска", "Toshkend"): closest name, only when it is unambiguous
  for (const cand of cands) {
    const f = fuzzy(index, cand, cc);
    if (f) return { city: f.city, how: 'fuzzy' };
  }
  if (cc) for (const cand of cands) { const f = fuzzy(index, cand, null); if (f) return { city: f.city, how: 'fuzzy' }; }

  // 4) the model knows roughly where it is: the nearest listed town (a small village next to a bigger town)
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    let best = null; let bestKm = 70;
    for (const e of index.entries) {
      if (cc && e.city.country !== cc) continue;
      const d = distanceKm({ lat, lng }, e.city);
      if (d < bestKm) { best = e; bestKm = d; }
    }
    if (best) return { city: best.city, how: 'nearest', km: Math.round(bestKm) };
  }
  return { city: null, how: null };
}

/**
 * Autocomplete: "xorazm" -> Urgench (note: Xorazm region), "ташк" -> Tashkent, "samarqand" -> Samarkand, "uz" -> biggest UZ towns.
 * Ranking: exact name > name starts with > a word starts with > alias starts with > contains; bigger towns first.
 */
function searchOnce(index, query, { limit = 8, country = null } = {}) {
  const q = fold(query);
  if (!q) {
    return index.entries.filter((e) => !country || e.city.country === country).sort((a, b) => b.pop - a.pop).slice(0, limit).map((e) => ({ city: e.city }));
  }
  const scored = new Map(); // city id -> { entry, score, note }
  const bump = (entry, score, note) => { const cur = scored.get(entry.city.id); if (!cur || score > cur.score) scored.set(entry.city.id, { entry, score, note }); };
  for (const e of index.entries) {
    if (country && e.city.country !== country) continue;
    const name = e.keys[0];
    for (const k of e.keys) {
      let s = 0;
      if (k === q) s = k === name ? 100 : 90;
      else if (k.startsWith(q)) s = k === name ? 70 : 60;
      else if (k.includes(` ${q}`)) s = 40;
      else if (q.length >= 3 && k.includes(q)) s = 20;
      if (s) bump(e, s, k !== name && s >= 40 ? e.raws.get(k) : ''); // "also written: Urganch"
    }
  }
  for (const [k, r] of index.regions) {
    if (country && r.entry.city.country !== country) continue;
    // a region typed in full leads to its capital, ahead of towns that merely carry the name as an old/alternate spelling
    if (k === q || k.startsWith(q)) bump(r.entry, k === q ? 92 : 55, r.region);
  }
  // typo-tolerant fallback so "Toshkend" or "Samarkant" still offer something
  if (scored.size < 3 && q.length >= 4) {
    const cap = q.length >= 8 ? 2 : 1;
    for (const e of index.entries) {
      if (country && e.city.country !== country) continue;
      for (const k of e.keys) { if (distance(q, k, cap) <= cap) { bump(e, 15, ''); break; } }
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || b.entry.pop - a.entry.pop || a.entry.city.label.localeCompare(b.entry.city.label))
    .slice(0, limit)
    .map((s) => ({ city: s.entry.city, note: s.note || undefined }));
}


// --- what people type into the box -----------------------------------------------------------------------------

const COUNTRY_WORDS = {
  UZ: 'uzbekistan ozbekiston uzbekiston o\'zbekiston узбекистан ўзбекистон узб уз',
  KZ: 'kazakhstan qozogiston qozog\'iston kazahstan казахстан қазақстан кз каз',
  RU: 'russia rossiya rossiia россия рф рус',
  KG: 'kyrgyzstan qirgiziston kirgiziya kyrgyzstan киргизия кыргызстан кыргызстан кг',
  TJ: 'tajikistan tojikiston tadzhikistan таджикистан тоҷикистон тж',
  TM: 'turkmenistan turkmaniston туркменистан тм',
  AZ: 'azerbaijan azerbaycan azerbaydzhan азербайджан аз',
  AM: 'armenia armeniya армения',
  GE: 'georgia gruziya грузия',
  BY: 'belarus belorussiya belarusiya беларусь белоруссия',
  UA: 'ukraine ukraina украина',
  TR: 'turkey turkiya turkiye turtsiya турция',
  CN: 'china xitoy kitai китай',
  IR: 'iran eron иран',
  AF: 'afghanistan afgoniston афганистан',
  MN: 'mongolia mongoliya монголия',
};
const COUNTRY_OF = new Map();
for (const [cc, words] of Object.entries(COUNTRY_WORDS)) { COUNTRY_OF.set(cc.toLowerCase(), cc); for (const w of words.split(' ')) COUNTRY_OF.set(fold(w), cc); }

/** Wrong keyboard layout: "Vjcrdf" is what you get typing "Москва" with the English layout on (and the other way round). */
const EN_ROW = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_ROW = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const swapLayout = (text, from, to) => [...text].map((ch) => { const i = from.indexOf(ch.toLowerCase()); return i < 0 ? ch : to[i]; }).join('');
const hasLatin = (t) => /[a-z]/i.test(t);
const hasCyr = (t) => /[а-яё]/i.test(t);

/** "ташкент уз" / "Tashkent UZ" / "Tashkent, UZ" / "Ташкент, Узбекистан" -> { name, country }. */
export function splitQuery(raw) {
  const parts = String(raw ?? '').split(',').map((x) => x.trim());
  let name = parts[0] ?? ''; let country = null;
  if (parts.length > 1 && parts[1]) country = COUNTRY_OF.get(fold(parts[1])) ?? null;
  if (!country) {
    const w = name.split(/\s+/);
    const last = COUNTRY_OF.get(fold(w[w.length - 1]));
    if (w.length > 1 && last) { country = last; name = w.slice(0, -1).join(' '); }
  }
  return { name, country };
}

/**
 * Autocomplete. Understands the country typed after the name, Russian endings ("в Москве"), spelling variants and
 * text typed with the wrong keyboard layout. `country` (ISO-2) narrows the search when given explicitly.
 */
export function searchCities(index, query, { limit = 8, country = null } = {}) {
  const sp = splitQuery(query);
  const cc = country ?? sp.country;
  const name = sp.name;
  let hits = searchOnce(index, name, { limit, country: cc });
  if (!hits.length && name.length >= 2) {
    const alt = hasLatin(name) && !hasCyr(name) ? swapLayout(name, EN_ROW, RU_ROW) : hasCyr(name) && !hasLatin(name) ? swapLayout(name, RU_ROW, EN_ROW) : '';
    if (alt && alt !== name) hits = searchOnce(index, alt, { limit, country: cc });
  }
  if (!hits.length && name.length >= 5) hits = searchOnce(index, name.slice(0, -1), { limit, country: cc }); // "Москву", "Москве" -> "Москв"
  return hits;
}
