// Verifies GEMINI_API_KEY / GEMINI_MODEL with one real call, using a sample post:
//   GEMINI_API_KEY=... npm run ai:check
// Prints what the AI understood, so you can see the key works before going live.
import { createGeminiParser } from '../src/lib/ai/gemini.js';
import { buildCityIndex, resolveCity } from '../src/lib/ai/cities.js';
import { createPool } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgres://unused' });
if (!config.geminiApiKey) { console.error('Set GEMINI_API_KEY first (https://aistudio.google.com/apikey).'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL too (the city list is read from your database).'); process.exit(1); }

const pool = createPool(config);
const { rows } = await pool.query('SELECT id, label, name, name_ru, country, lat, lng FROM cities ORDER BY id');
await pool.end();
const index = buildCityIndex(rows);

const sample = `🇷🇺МОСКВА ЭЛЕКТРОГОРСК
🇺🇿ХОРАЗМ
ДСП МДФ
ТЕНТ РЕФ ФУРА
ОПЛАТА НАХТ
ПОГРУЗКА ТАЙЙОР
АВАНС БОР
+998918887695


🇷🇺КАЛУГА ЛЮДИНОВО
🇺🇿БУХОРО
🇺🇿ХОРАЗМ
ДСП МДФ
ТЕНТ ФУРА
+998918887695`;

const ai = createGeminiParser({ apiKey: config.geminiApiKey, model: config.geminiModel });
console.log(`Calling ${ai.name} ...`);
const t0 = Date.now();
try {
  const out = await ai.parseLoads({ text: sample, cities: index.cities, today: new Date().toISOString().slice(0, 10) });
  console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s - ${out.loads.length} load(s):`);
  for (const l of out.loads) {
    const o = resolveCity(index, { label: l.origin.cityLabel, text: l.origin.place }).city?.label;
    const d = resolveCity(index, { label: l.destinations[0]?.cityLabel, text: l.destinations[0]?.place }).city?.label;
    console.log(` - ${l.origin.place} -> ${l.destinations.map((x) => x.place).join(' / ')}   =>   ${o} -> ${d}   [${l.equipment.join('/')}] ${l.commodity} | ${l.notes} | ${l.phone}`);
  }
} catch (err) {
  console.error(`FAILED: ${err.code ?? ''} ${err.message}`);
  if (err.logDetail) console.error(err.logDetail);
  process.exit(1);
}
