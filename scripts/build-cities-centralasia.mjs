// Generates server/migrations/013_cities_central_asia.sql from the GeoNames country dumps
// (https://www.geonames.org, licence CC BY 4.0 - see README credits):
//   * EVERY populated place of Uzbekistan, Kazakhstan, Kyrgyzstan, Tajikistan and Turkmenistan, villages included (trucks
//     go there), plus all district / region seats,
//   * names in Russian, Uzbek, English, Tajik, Kazakh, Kyrgyz, Turkmen ... as aliases, so a place is found however it is written,
//   * every district and region (Nohiyai Khuroson, Qashqadaryo viloyati ...) as an alias of its seat town, so typing the
//     district or an old name (Kuybyshevsk) leads to the right town.
// Existing city ids are never touched. Needs the dumps in $GEO_DIR (default /tmp/geo2), see the download commands below.
//
//   for CC in UZ KZ KG TJ TM; do
//     curl -O https://download.geonames.org/export/dump/$CC.zip ; curl -o ${CC}alt.zip https://download.geonames.org/export/dump/alternatenames/$CC.zip
//   done; curl -O https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   (unzip each into main_$CC/ and alt_$CC/)   then:   node scripts/build-cities-centralasia.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fold } from '../server/src/lib/ai/cities.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEO = process.env.GEO_DIR || '/tmp/geo2';
const COUNTRIES = ['UZ', 'KZ', 'KG', 'TJ', 'TM'];
const MIN_POP = 0; // most villages have no population figure in GeoNames, but trucks still go there
const LANGS = ['ru', 'uz', 'en', 'tg', 'kk', 'ky', 'tk', 'qq', 'uk', 'be', ''];  // '' = a name without a language tag (often a transliteration)
const REAL = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLG', 'PPLL', 'PPLS']);
const SEAT = new Set(['PPLA', 'PPLA2', 'PPLA3', 'PPLC']);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const rad = (d) => (d * Math.PI) / 180;
const km = (a, b) => { const x = rad(b.lat - a.lat); const y = rad(b.lng - a.lng); const h = Math.sin(x / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(y / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const lev = (a, b) => { const p = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let d = p[0]; p[0] = i; for (let j = 1; j <= b.length; j += 1) { const t = p[j]; p[j] = Math.min(p[j] + 1, p[j - 1] + 1, d + (a[i - 1] === b[j - 1] ? 0 : 1)); d = t; } } return p[b.length]; };
const unq = (s) => s.replace(/''/g, "'");

// ---- the cities we already have (migrations 002 + 007): label, name, country, coordinates, aliases, population
const existing = new Map();
const sql002 = fs.readFileSync(path.join(root, 'server/migrations/002_cities.sql'), 'utf8');
for (const m of sql002.matchAll(/^\s*\('((?:[^']|'')*)', '((?:[^']|'')*)', '([A-Z]{2})', ([\d.-]+), ([\d.-]+), '((?:[^']|'')*)'/gm)) {
  existing.set(unq(m[6]), { name: unq(m[1]), country: m[3], lat: Number(m[4]), lng: Number(m[5]), label: unq(m[6]), aliases: [], population: 0, changed: false });
}
const sql007 = fs.readFileSync(path.join(root, 'server/migrations/007_cities_gazetteer.sql'), 'utf8');
for (const m of sql007.matchAll(/^\s*\('((?:[^']|'')*)', '((?:[^']|'')*)', ([\d]+)\)[,]?$/gm)) {
  const e = existing.get(unq(m[1])); if (e) { e.aliases = unq(m[2]).split(/\s*;\s*/).filter(Boolean); e.population = Number(m[3]); }
}
for (const m of sql007.matchAll(/^\s*\('((?:[^']|'')*)', '((?:[^']|'')*)', '([A-Z]{2})', ([\d.-]+), ([\d.-]+), '((?:[^']|'')*)', '(?:[^']|'')*', (\d+), '((?:[^']|'')*)'\)/gm)) {
  existing.set(unq(m[6]), { name: unq(m[1]), country: m[3], lat: Number(m[4]), lng: Number(m[5]), label: unq(m[6]), aliases: unq(m[8]).split(/\s*;\s*/).filter(Boolean), population: Number(m[7]), changed: false });
}
if (existing.size < 1000) throw new Error(`parsed only ${existing.size} existing cities`);
const taken = new Set([...existing.values()].map((e) => `${e.name.toLowerCase()}|${e.country}`));
const takenLabel = new Set([...existing.keys()].map((l) => l.toLowerCase()));
const keysOf = (e) => new Set([e.name, ...e.aliases].map(fold).filter(Boolean));

// ---- admin1 names (for labelling same-named villages "Yangiobod (Tashkent), UZ")
const admin1 = new Map();
for (const line of fs.readFileSync(path.join(GEO, 'admin1.txt'), 'utf8').split('\n')) { const c = line.split('\t'); if (c[0]) admin1.set(c[0], c[2] || c[1]); }

const inserts = [];
const insertGrid = new Map(); // "country|lat|lng" cell -> inserts (to merge twins)
const cell = (c) => `${c.country}|${Math.round(c.lat * 10)}|${Math.round(c.lng * 10)}`;
const stripAdmin = (n) => n.replace(/^(Nohiyai|Nohiya|Nohiyasi|Rayon|Raion|Region|Tuman|District of)\s+/i, '').replace(/\s+(District|Rayon|Raion|Region|Oblast|Province|Viloyati|Tumani|Nohiyasi|Nohiya|Municipality|City)$/i, '').trim();

const stats = {};
for (const cc of COUNTRIES) {
  const rows = fs.readFileSync(path.join(GEO, `main_${cc}`, `${cc}.txt`), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
  const alt = new Map(); // geonameid -> [{lang, name}]
  for (const l of fs.readFileSync(path.join(GEO, `alt_${cc}`, `${cc}.txt`), 'utf8').split('\n')) {
    const c = l.split('\t'); if (c.length < 4) continue;
    if (!LANGS.includes(c[2])) continue;
    if (c[7] === '1' && c[2] !== '' && c[2] !== 'ru') continue; // historic names only when untagged or Russian (Kuybyshevsk)
    if (!alt.has(c[1])) alt.set(c[1], []);
    alt.get(c[1]).push({ lang: c[2], name: c[3] });
  }
  const namesOf = (r) => {
    const out = [r[1], r[2]];
    const list = (alt.get(r[0]) || []).slice().sort((a, b) => LANGS.indexOf(a.lang) - LANGS.indexOf(b.lang));
    for (const a of list) if (a.name && a.name.length <= 40 && !/^https?:|^\d+$/.test(a.name)) out.push(a.name);
    const seen = new Set(); const uniq = [];
    for (const n of out) { const f = fold(n); if (f && !seen.has(f)) { seen.add(f); uniq.push(n.replace(/;/g, ',')); } }
    return uniq;
  };
  const place = (r) => ({ id: r[0], name: r[2] || r[1], country: cc, lat: Number(r[4]), lng: Number(r[5]), population: Number(r[14]) || 0, a1: r[10], a2: r[11], fcode: r[7], names: namesOf(r), ruName: (alt.get(r[0]) || []).find((a) => a.lang === 'ru')?.name });

  // villages with no population figure are kept only when they carry a name in another language (a sign that people know them)
  const places = rows.filter((r) => r[6] === 'P' && REAL.has(r[7])).map(place)
    .filter((g) => g.population > 0 || SEAT.has(g.fcode) || g.names.length >= 3).sort((a, b) => b.population - a.population);
  // 1) every place: merge into an existing city (same spot / same name nearby) or import it as a new one
  const resolved = new Map(); // geoname id -> the city record (existing or new) that now represents it
  const mine = [...existing.values()].filter((e) => e.country === cc);
  for (const g of places) {
    const gk = new Set(g.names.map(fold));
    let target = null;
    for (const e of mine) {
      const d = km(e, g);
      if (d < 4) { target = e; break; }
      if (d < 30 && [...keysOf(e)].some((k) => gk.has(k))) { target = e; break; }
      if (d < 25 && lev(fold(e.name), fold(g.name)) <= 2) { target = e; break; }
    }
    if (target) {
      const have = keysOf(target);
      for (const n of g.names) if (!have.has(fold(n))) { target.aliases.push(n); have.add(fold(n)); target.changed = true; }
      if (g.population > target.population) { target.population = g.population; target.changed = true; }
      resolved.set(g.id, target);
      continue;
    }
    const twin = (insertGrid.get(cell(g)) || []).find((i) => km(i, g) < 3 && [...i.keys].some((k) => gk.has(k)));
    if (twin) { for (const n of g.names) if (!twin.keys.has(fold(n))) { twin.aliases.push(n); twin.keys.add(fold(n)); } resolved.set(g.id, twin); continue; }
    let name = g.name; const region = admin1.get(`${cc}.${g.a1}`) || '';
    if (taken.has(`${name.toLowerCase()}|${cc}`) && region) name = `${g.name} (${region})`;
    if (taken.has(`${name.toLowerCase()}|${cc}`)) name = `${g.name} (${g.id})`;
    const rec = { name, country: cc, lat: g.lat, lng: g.lng, population: g.population, label: `${name}, ${cc}`, nameRu: g.ruName || g.name, aliases: g.names.filter((n) => fold(n) !== fold(g.name)), keys: new Set(g.names.map(fold)), plainName: g.name };
    // the plain name is also searchable for the disambiguated ones ("Yangiobod" finds all Yangiobods)
    if (name !== g.name) { rec.aliases.unshift(g.name); }
    taken.add(`${name.toLowerCase()}|${cc}`); takenLabel.add(rec.label.toLowerCase());
    inserts.push(rec);
    if (!insertGrid.has(cell(g))) insertGrid.set(cell(g), []);
    insertGrid.get(cell(g)).push(rec);
    resolved.set(g.id, rec);
  }
  // 2) districts and regions: their names become aliases of the seat town
  const byA1 = new Map(); const byA2 = new Map();
  for (const g of places) {
    const k1 = g.a1; const k2 = `${g.a1}.${g.a2}`;
    if (!byA1.has(k1)) byA1.set(k1, []); byA1.get(k1).push(g);
    if (g.a2) { if (!byA2.has(k2)) byA2.set(k2, []); byA2.get(k2).push(g); }
  }
  const seatOf = (list, code) => list && (list.filter((g) => g.fcode === code).sort((a, b) => b.population - a.population)[0] || list.slice().sort((a, b) => b.population - a.population)[0]);
  const byFold = new Map();
  for (const g of places) for (const n of g.names) { const f = fold(n); if (!byFold.has(f)) byFold.set(f, []); byFold.get(f).push(g); }
  let areas = 0;
  for (const r of rows) {
    if (r[6] !== 'A' || !['ADM1', 'ADM2', 'ADM3'].includes(r[7])) continue;
    const centre = { lat: Number(r[4]), lng: Number(r[5]) };
    let seat = null;
    if (r[7] === 'ADM1') seat = seatOf(byA1.get(r[10]), 'PPLA');
    // 1) a place carrying the district's own name (Vakhsh district -> Vakhsh), same region preferred
    if (!seat) {
      const f = fold(stripAdmin(r[2] || r[1]));
      const named = (byFold.get(f) || []).filter((g) => km(g, centre) < 80).sort((a, b) => (b.a1 === r[10]) - (a.a1 === r[10]) || b.population - a.population);
      seat = named[0] || null;
    }
    // 2) the district's seat by admin code, 3) the biggest town near its centre
    if (!seat && r[7] === 'ADM2') seat = seatOf(byA2.get(`${r[10]}.${r[11]}`), 'PPLA2');
    if (!seat) {
      const near = places.filter((g) => g.population >= 1500 && km(g, centre) < 25).sort((a, b) => b.population - a.population);
      seat = near[0] || null;
    }
    const rec = seat && resolved.get(seat.id);
    if (!rec) continue;
    const have = rec.keys || (rec.keys = keysOf(rec));
    const names = namesOf(r).flatMap((n) => [n, stripAdmin(n)]);
    for (const n of names) {
      const f = fold(n); if (!f || have.has(f) || n.length < 3) continue;
      rec.aliases.push(n); have.add(f); rec.changed = true; areas += 1;
    }
  }
  stats[cc] = { places: places.length, areaAliases: areas };
}

// ---- hand-written additions (names people use that GeoNames files under a district or an old name)
const EXTRA = { 'TJ|Vakhsh': 'Khuroson; Xuroson; Хуросон; Хуросан; Nohiyai Khuroson; Kuybyshevsk; Куйбышевск' };
for (const [key, list] of Object.entries(EXTRA)) {
  const [cc, name] = key.split('|');
  const rec = inserts.find((i) => i.country === cc && (i.name === name || i.plainName === name)) || [...existing.values()].find((e) => e.country === cc && e.name === name);
  if (!rec) { console.warn('EXTRA alias target missing:', key); continue; }
  const have = rec.keys || keysOf(rec);
  for (const n of list.split(/\s*;\s*/)) if (!have.has(fold(n))) { rec.aliases.push(n); have.add(fold(n)); rec.changed = true; }
}

// ---- write the migration
const changed = [...existing.values()].filter((e) => e.changed);
const trim = (list) => { const seen = new Set(); const out = []; for (const a of list) { const f = fold(a); if (f && !seen.has(f)) { seen.add(f); out.push(a); } } return out.slice(0, 40).join('; '); };
const lines = [];
lines.push(`-- GENERATED by scripts/build-cities-centralasia.mjs - do not edit by hand (re-run the script instead).
-- ${inserts.length} more places in Uzbekistan, Kazakhstan, Kyrgyzstan, Tajikistan and Turkmenistan (every populated place, villages
-- included, and all district / region seats), from the GeoNames gazetteer (https://www.geonames.org, CC BY 4.0), and the
-- Russian / Uzbek / English / Tajik / Kazakh / Kyrgyz names of places, districts and regions as search aliases of ${changed.length} existing cities.
-- Existing ids are untouched.
`);
lines.push('UPDATE cities c SET aliases = v.aliases, population = GREATEST(c.population, v.population) FROM (VALUES');
lines.push(changed.map((e) => `    (${q(e.label)}, ${q(trim(e.aliases))}, ${e.population})`).join(',\n'));
lines.push(') AS v(label, aliases, population) WHERE c.label = v.label;\n');
lines.push('INSERT INTO cities (name, name_ru, country, lat, lng, label, search_key, population, aliases) VALUES');
lines.push(inserts.map((c) => `    (${q(c.name)}, ${q(c.nameRu)}, ${q(c.country)}, ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}, ${q(c.label)}, ${q(`${c.name} ${c.nameRu}`.toLowerCase())}, ${c.population}, ${q(trim(c.aliases))})`).join(',\n'));
lines.push('ON CONFLICT DO NOTHING;');
fs.writeFileSync(path.join(root, 'server/migrations/013_cities_central_asia.sql'), `${lines.join('\n')}\n`);
console.log('stats', stats, 'inserted', inserts.length, 'existing updated', changed.length);
console.log('size', (fs.statSync(path.join(root, 'server/migrations/013_cities_central_asia.sql')).size / 1e6).toFixed(2), 'MB');
