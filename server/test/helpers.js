import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { phoneIdentity } from '../src/lib/identity.js';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

/** Test token format: "test:<email>[:<name>]". Only the injected test verifier understands it. */
export const tokenFor = (email, name) => (/^\+\d/.test(email) ? `testphone:${email}` : `test:${email}${name ? `:${name}` : ''}`);

async function testVerifier(token) {
  const [prefix, email, name] = String(token).split(':');
  if (prefix === 'testphone' && /^\+\d{8,15}$/.test(email ?? '')) {
    return { uid: `uid-${email}`, email: phoneIdentity(email), loginEmail: '', phone: email, provider: 'phone', name: '', picture: '' };
  }
  if (prefix !== 'test' || !email) throw new Error('bad test token');
  return { uid: `uid-${email}`, email: email.toLowerCase(), loginEmail: email.toLowerCase(), phone: '', provider: 'google.com', name: name ?? email.split('@')[0], picture: '' };
}

/** Boots a throwaway real PostgreSQL + the real app (migrations included). */
export async function startTestEnv(envOverrides = {}, { ai = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sng-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => {}, onError: () => {},
  });
  await pg.initialise();
  await pg.start();

  const config = loadConfig({
    DATABASE_URL: `postgres://postgres:pw@127.0.0.1:${port}/postgres`,
    NODE_ENV: 'test', LOG_LEVEL: 'silent', OWNER_EMAILS: 'owner@test.com', WEB_ROOT: path.join(dir, 'no-web'),
    RATE_LIMIT_PER_MIN: '100000', WRITE_RATE_LIMIT_PER_MIN: '100000', DB_POOL_MAX: '10',
    COUNT_CACHE_MS: '0', MEMBER_CACHE_MS: '0', EVENT_BATCH_MS: '0', SEARCH_CACHE_MS: '0', // off by default so tests see every write immediately
    ...envOverrides,
  });
  const pool = createPool(config);
  await runMigrations(pool, { log() {}, info() {} });
  const app = await buildApp({ config, pool, verifyToken: testVerifier, ai });
  await app.ready();

  const as = (email, name) => {
    const headers = { authorization: `Bearer ${tokenFor(email, name)}` };
    const call = async (method, url, payload) => {
      const res = await app.inject({ method, url, headers: { ...headers, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, payload: payload !== undefined ? JSON.stringify(payload) : undefined });
      let json = null;
      try { json = res.body ? JSON.parse(res.body) : null; } catch { /* non-JSON body */ }
      return { status: res.statusCode, json, headers: res.headers };
    };
    return {
      get: (url) => call('GET', url), post: (url, body) => call('POST', url, body ?? {}), patch: (url, body) => call('PATCH', url, body),
      put: (url, body) => call('PUT', url, body), del: (url) => call('DELETE', url),
    };
  };

  const cityId = async (label) => (await pool.query('SELECT id FROM cities WHERE label = $1', [label])).rows[0].id;

  /** Insert an already-approved member directly (bypasses the HTTP flow on purpose). */
  const approvedMember = async (email, company = `${email} Co`) => (await pool.query(
    `INSERT INTO members (email, company, contact_name, phone, telegram, status, reviewed_at)
     VALUES ($1, $2, 'Dispatcher', '+998 90 123 45 67', '@dispatch', 'approved', now())
     ON CONFLICT (email) DO UPDATE SET status = 'approved' RETURNING *`, [email, company])).rows[0];

  return {
    app, pool, config, as, cityId, approvedMember,
    async close() {
      await app.close();
      await pool.end();
      await pg.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const validLoad = (originCityId, destCityId, over = {}) => ({
  originCityId, destCityId, equip: 'T', fp: 'Full', weightT: 21.5, volumeM3: 90,
  pickupDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
  rateUsd: 2500, commodity: 'Textiles', contactName: 'Dias', contactPhone: '+7 727 880 1234',
  contactEmail: 'dispatch@example.com', contactTelegram: '@dias_disp', ...over,
});
