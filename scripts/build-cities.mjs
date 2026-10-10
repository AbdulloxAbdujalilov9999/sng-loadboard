// Generates server/migrations/007_cities_gazetteer.sql: ~2,000 more towns for the region, with coordinates and
// population, from the GeoNames gazetteer (https://www.geonames.org, licence CC BY 4.0 - see README credits).
//
//   npm install --no-save all-the-cities@3.1.0     # GeoNames "cities1000" as an npm package (not a runtime dependency)
//   node scripts/build-cities.mjs
//
// The generated SQL is committed, so the app and CI never need the package. Re-run only to change the country list
// or thresholds. Existing city ids (loads reference them) are never touched: a gazetteer town that matches one of
// the original cities only contributes its population and spelling aliases to it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fold } from '../server/src/lib/ai/cities.js';
import { ALIASES } from './city-aliases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let all;
try { all = require('all-the-cities'); } catch { console.error('Run first:  npm install --no-save all-the-cities@3.1.0'); process.exit(1); }

// country -> minimum population to import. Small countries get a low bar (every town matters for freight),
// big ones a higher one (so the list stays fast to search).
const THRESHOLD = {
  RU: 15000, KZ: 8000, UZ: 1000, KG: 3000, TJ: 3000, TM: 3000, AZ: 15000, GE: 10000, AM: 10000, BY: 25000, UA: 50000, MD: 15000,
  TR: 150000, IR: 400000, AF: 200000, CN: 1500000, MN: 60000, PL: 300000, DE: 500000, RO: 250000, BG: 150000, LT: 100000, LV: 100000, EE: 100000,
};

// ---- the original 160 cities (their ids must not change)
const sql002 = fs.readFileSync(path.join(root, 'server/migrations/002_cities.sql'), 'utf8');
const existing = [...sql002.matchAll(/^\s*\('((?:[^']|'')*)', '((?:[^']|'')*)', '([A-Z]{2})', ([\d.-]+), ([\d.-]+), '((?:[^']|'')*)', '((?:[^']|'')*)'\)/gm)]
  .map((m) => ({ name: m[1].replace(/''/g, "'"), nameRu: m[2], country: m[3], lat: Number(m[4]), lng: Number(m[5]), label: m[6].replace(/''/g, "'") }));
if (existing.length < 150) throw new Error(`parsed only ${existing.length} existing cities`);

const rad = (d) => (d * Math.PI) / 180;
const km = (a, b) => {
  const x = rad(b.lat - a.lat); const y = rad(b.lng - a.lng);
  const h = Math.sin(x / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(y / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const lev = (a, b) => { const p = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i += 1) { let d = p[0]; p[0] = i; for (let j = 1; j <= b.length; j += 1) { const t = p[j]; p[j] = Math.min(p[j] + 1, p[j - 1] + 1, d + (a[i - 1] === b[j - 1] ? 0 : 1)); d = t; } } return p[b.length]; };
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// PPLX = a district/neighbourhood INSIDE a city (e.g. Moscow's Luzhniki): not a place a truck goes to. PPLH/PPLQ/PPLW = historical/abandoned.
const REAL_TOWN = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLC', 'PPLG', 'PPLL', 'PPLS']);
const gaz = all.filter((c) => REAL_TOWN.has(c.featureCode) && THRESHOLD[c.country] !== undefined && c.population >= THRESHOLD[c.country])
  .map((c) => ({ name: c.name, country: c.country, lat: c.loc.coordinates[1], lng: c.loc.coordinates[0], population: c.population }))
  .sort((a, b) => b.population - a.population);

// ---- match gazetteer towns to the original cities (same place, different spelling) -> aliases + population
const updates = new Map(); // label -> { aliases:Set, population }
for (const e of existing) updates.set(e.label, { aliases: new Set(), population: 0 });
const taken = new Set(existing.map((e) => e.label.toLowerCase()));
const takenName = new Set(existing.map((e) => `${e.name.toLowerCase()}|${e.country}`));
const inserts = [];
for (const g of gaz) {
  const near = existing.filter((e) => e.country === g.country && km(e, g) < 40)
    .map((e) => ({ e, d: lev(fold(e.name), fold(g.name)) })).sort((a, b) => a.d - b.d)[0];
  // The same town spelled differently (Urganch / Urgench): name within 2 edits AND close by. Anything else near a big
  // city is a suburb/satellite town - it is imported as its own place, never merged into the city's aliases.
  const closest = existing.map((e) => ({ e, km: km(e, g) })).sort((a, b) => a.km - b.km)[0];
  if ((near && near.d <= 2 && km(near.e, g) < 25) || (closest && closest.km < 4)) {
    // ... or the very same spot under another name (Nur-Sultan = Astana, Ordzhonikidze = ...): merge, keep the old id
    const target = near && near.d <= 2 && km(near.e, g) < 25 ? near.e : closest.e;
    const u = updates.get(target.label);
    u.population = Math.max(u.population, g.population);
    if (fold(g.name) !== fold(target.name)) u.aliases.add(g.name);
    continue;
  }
  // the same spot as a town we are already importing (a bigger one is listed first): add the name as its alias
  const twin = inserts.find((i) => i.country === g.country && Math.abs(i.lat - g.lat) < 0.05 && Math.abs(i.lng - g.lng) < 0.05 && km(i, g) < 3);
  if (twin) { if (fold(twin.name) !== fold(g.name)) twin.aliases.add(g.name); continue; }
  let label = `${g.name}, ${g.country}`;
  if (taken.has(label.toLowerCase()) || takenName.has(`${g.name.toLowerCase()}|${g.country}`)) continue; // a bigger town already owns this name
  taken.add(label.toLowerCase()); takenName.add(`${g.name.toLowerCase()}|${g.country}`);
  inserts.push({ ...g, label, aliases: new Set() });
}

// hand-written spellings / Russian names / nicknames for the original cities
for (const [label, list] of Object.entries(ALIASES)) {
  const u = updates.get(label);
  if (!u) throw new Error(`alias table mentions unknown city ${label}`);
  for (const a of list.split(/\s*[;|]\s*/).filter(Boolean)) u.aliases.add(a);
}

const out = [];
out.push(`-- GENERATED by scripts/build-cities.mjs - do not edit by hand (re-run the script instead).
-- ${inserts.length} more towns for the region from the GeoNames gazetteer (https://www.geonames.org, CC BY 4.0),
-- plus spelling aliases and populations for the original ${existing.length} cities. Existing ids are untouched.
-- aliases: other spellings people really write (Urganch/Urgench, Xiva/Khiva, Кокан/Qo'qon ...), matched case- and
-- script-insensitively by the app. population: used to rank autocomplete results and break ties.

ALTER TABLE cities ADD COLUMN aliases    text    NOT NULL DEFAULT '';
ALTER TABLE cities ADD COLUMN population integer NOT NULL DEFAULT 0;
`);
out.push('UPDATE cities c SET aliases = v.aliases, population = v.population FROM (VALUES');
out.push([...updates.entries()].map(([label, u]) => `    (${q(label)}, ${q([...u.aliases].join('; '))}, ${u.population})`).join(',\n'));
out.push(') AS v(label, aliases, population) WHERE c.label = v.label;\n');
out.push('INSERT INTO cities (name, name_ru, country, lat, lng, label, search_key, population, aliases) VALUES');
out.push(inserts.map((c) => `    (${q(c.name)}, ${q(c.name)}, ${q(c.country)}, ${c.lat.toFixed(4)}, ${c.lng.toFixed(4)}, ${q(c.label)}, ${q(c.name.toLowerCase())}, ${c.population}, ${q([...c.aliases].join('; '))})`).join(',\n'));
out.push('ON CONFLICT DO NOTHING;');
fs.writeFileSync(path.join(root, 'server/migrations/007_cities_gazetteer.sql'), `${out.join('\n')}\n`);

const byCountry = {};
for (const c of inserts) byCountry[c.country] = (byCountry[c.country] || 0) + 1;
console.log(`wrote 007_cities_gazetteer.sql: ${inserts.length} new towns`, byCountry);
console.log(`matched to original cities: ${[...updates.values()].filter((u) => u.population > 0).length}/${existing.length}`);
