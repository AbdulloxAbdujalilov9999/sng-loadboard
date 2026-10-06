import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestEnv } from './helpers.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
let env;
before(async () => { env = await startTestEnv(); });
after(async () => { await env.close(); });

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function run(extraEnv) {
  const child = spawn(process.execPath, [ENTRY], { env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: env.config.databaseUrl, OWNER_EMAILS: 'owner@test.com', LOG_LEVEL: 'silent', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => out };
}

async function waitHealthy(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.status === 200) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server never became healthy');
}

test('production boot: refuses unsafe/invalid configuration with a clear message', async () => {
  const noOwner = run({ PORT: String(await freePort()), OWNER_EMAILS: '' });
  assert.equal((await noOwner.exited).code, 1);
  assert.match(noOwner.output(), /OWNER_EMAILS is required in production/);

  const fakeAuth = run({ PORT: String(await freePort()), DEV_FAKE_AUTH: '1' });
  assert.equal((await fakeAuth.exited).code, 1);
  assert.match(fakeAuth.output(), /DEV_FAKE_AUTH must never be enabled in production/);

  const noDb = run({ PORT: String(await freePort()), DATABASE_URL: '' });
  assert.equal((await noDb.exited).code, 1);
  assert.match(noDb.output(), /DATABASE_URL is required/);
});

test('single process: boots, serves, real token verifier rejects junk, SIGTERM drains cleanly', async () => {
  const port = await freePort();
  const p = run({ PORT: String(port), WEB_CONCURRENCY: '1' });
  try {
    await waitHealthy(port);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { authorization: 'Bearer junk' } })).status, 401);
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    assert.equal(cfg.devAuth, false, 'fake sign-in is never advertised in production');
  } finally { p.child.kill('SIGTERM'); }
  const { code } = await p.exited;
  assert.equal(code, 0, `clean exit, got ${code}\n${p.output()}`);
});

test('cluster mode: 2 workers share the port and the whole group shuts down on SIGTERM', async () => {
  const port = await freePort();
  const p = run({ PORT: String(port), WEB_CONCURRENCY: '2' });
  try {
    await waitHealthy(port);
    const results = await Promise.all(Array.from({ length: 40 }, () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.status)));
    assert.ok(results.every((s) => s === 200));
    assert.match(p.output(), /2 workers/);
  } finally { p.child.kill('SIGTERM'); }
  const { code } = await p.exited;
  assert.equal(code, 0, `clean exit, got ${code}\n${p.output()}`);
});

test('cluster mode fails loudly (instead of restarting forever) when workers cannot boot', async () => {
  // Invalid DB host: every worker crashes during startup.
  const p = run({ PORT: String(await freePort()), WEB_CONCURRENCY: '2', AUTO_MIGRATE: 'false', DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none' });
  const result = await Promise.race([p.exited, new Promise((r) => setTimeout(() => r({ code: 'STILL_RUNNING' }), 40_000))]);
  p.child.kill('SIGKILL');
  assert.equal(result.code, 1, `expected the primary to give up, got ${result.code}`);
  assert.match(p.output(), /FATAL: \d+ worker crashes/);
});
