// Local development server: a real Postgres (embedded, nothing to install) + the real API + FAKE sign-in.
//   npm run build:web && npm run dev:fake-auth        ->  http://localhost:8080
// Anyone can "sign in" as any email (tokens look like "dev:alice@example.com"); the owner is
// owner@dev.local. It refuses to run when NODE_ENV=production and is never used by Docker/CI deploys.
import cluster from 'node:cluster';
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig } from '../src/config.js';
import { start } from '../src/start.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { insertLoads, insertMembers, insertTrucks } from './lib/generate.js';
import { createGeminiParser } from '../src/lib/ai/gemini.js';
import { createHeuristicParser } from '../src/lib/ai/heuristic.js';

if (process.env.NODE_ENV === 'production') { console.error('dev-server refuses to run in production.'); process.exit(1); }

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const port = Number(arg('port', process.env.PORT || 8080));
const dbPort = Number(arg('db-port', 54399));
const dataDir = path.resolve(arg('data', '.dev-db'));
const seedLoads = Number(arg('seed', 0));
const soakMembers = Number(arg('members', 0)); // approved soak1..N@example.com accounts for `npm run soak -- --external`

// Cluster workers re-run this whole file, so only the primary may own Postgres and seeding.
const isPrimary = cluster.isPrimary;
let pg = null;
if (isPrimary) {
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'dev', port: dbPort, persistent: true, onLog: () => {}, onError: () => {} });
  if (fresh) await pg.initialise();
  await pg.start();
}

const config = loadConfig({
  ...process.env, DATABASE_URL: `postgres://postgres:dev@127.0.0.1:${dbPort}/postgres`, PORT: String(port), NODE_ENV: 'development',
  OWNER_EMAILS: process.env.OWNER_EMAILS || 'owner@dev.local', DEV_FAKE_AUTH: '1',
  RATE_LIMIT_PER_MIN: process.env.RATE_LIMIT_PER_MIN || '100000', WRITE_RATE_LIMIT_PER_MIN: process.env.WRITE_RATE_LIMIT_PER_MIN || '100000',
});

if (isPrimary && seedLoads > 0) {
  const pool = createPool(config);
  await runMigrations(pool, console);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM loads');
  if (n === 0) {
    const owners = await insertMembers(pool, { count: 40, prefix: 'demo' });
    await insertLoads(pool, { count: seedLoads, owners, onProgress: (d, t) => process.stdout.write(`\rseeding loads ${d}/${t}`) });
    await insertTrucks(pool, { count: Math.round(seedLoads / 5), owners });
    await pool.query('ANALYZE loads; ANALYZE trucks');
    console.log(`\nseeded ${seedLoads} loads (members demo1..demo40@example.com)`);
  }
  await pool.end();
}

if (isPrimary && soakMembers > 0) {
  const pool = createPool(config);
  await runMigrations(pool, console);
  await pool.query(`INSERT INTO members (email, company, contact_name, phone, telegram, status, reviewed_at)
    SELECT 'soak' || g || '@example.com', 'Soak Co ' || g, 'Dispatcher', '+998 90 123 45 67', '@soak_' || g, 'approved', now() FROM generate_series(1, $1) g
    ON CONFLICT (email) DO NOTHING`, [soakMembers]);
  await pool.end();
  console.log(`ensured ${soakMembers} approved soak members`);
}

async function fakeVerify(token) {
  const [prefix, email, name] = String(token).split(':');
  if (prefix !== 'dev' || !/^[^@\s:]+@[^@\s:]+$/.test(email ?? '')) throw new Error('bad dev token');
  return { uid: `dev-${email}`, email: email.toLowerCase(), name: name || email.split('@')[0], picture: '' };
}

const stopDb = async () => { try { await pg?.stop(); } catch { /* already stopped */ } };
// Real Gemini when GEMINI_API_KEY is set, otherwise the offline rule-based reader so the feature can be tried locally.
const ai = config.geminiApiKey ? createGeminiParser({ apiKey: config.geminiApiKey, model: config.geminiModel }) : createHeuristicParser();
const app = await start({ config, verifyToken: fakeVerify, onShutdown: stopDb, ai });
if (app) console.log(`\nDEV server on http://localhost:${port}  (fake sign-in; owner = ${config.ownerEmails.join(', ')})`);
