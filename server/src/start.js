import cluster from 'node:cluster';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

/**
 * Boots the API. With WEB_CONCURRENCY > 1 a small primary process forks that many workers that share
 * the listening port (the API is stateless, so throughput scales with cores). The primary applies
 * migrations once, restarts crashed workers, and drains everything on SIGTERM.
 */
export async function start({ config, verifyToken, onShutdown }) {
  if (config.workers > 1 && cluster.isPrimary) return startPrimary(config, onShutdown);
  return startWorker({ config, verifyToken, migrate: cluster.isPrimary, onShutdown });
}

async function startPrimary(config, onShutdown) {
  if (config.autoMigrate) {
    const pool = createPool({ ...config, dbPoolMax: 2 });
    try { await runMigrations(pool, console); } finally { await pool.end(); }
  }
  let stopping = false;
  const fork = () => cluster.fork();
  for (let i = 0; i < config.workers; i += 1) fork();
  // Restart crashed workers, but never loop forever: a worker that cannot boot (bad config, DB down)
  // must fail the whole service loudly so the orchestrator / operator sees it.
  const crashes = [];
  cluster.on('exit', (worker, code, signal) => {
    if (stopping) return;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 30_000) crashes.shift();
    console.error(`worker ${worker.process.pid} exited (${signal ?? code})`);
    if (crashes.length >= Math.max(5, config.workers * 2)) {
      console.error(`FATAL: ${crashes.length} worker crashes in 30s - giving up so the failure is visible`);
      stopping = true;
      for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM');
      setTimeout(() => process.exit(1), 500);
      return;
    }
    setTimeout(fork, 1000);
  });
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`primary: ${signal}, stopping ${Object.keys(cluster.workers).length} workers`);
    for (const w of Object.values(cluster.workers)) w.process.kill('SIGTERM');
    const done = setInterval(async () => {
      if (Object.keys(cluster.workers).length === 0) { await onShutdown?.(); process.exit(0); }
    }, 100);
    setTimeout(() => { clearInterval(done); process.exit(1); }, 12_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  console.log(`primary ${process.pid}: ${config.workers} workers on port ${config.port}`);
}

/** Fail fast (with a clear message) if the database is unreachable, but tolerate it still booting. */
async function assertDatabaseReachable(pool, attempts = 5) {
  for (let i = 1; i <= attempts; i += 1) {
    try { await pool.query('SELECT 1'); return; } catch (err) {
      if (i === attempts) throw new Error(`Cannot reach the database (${err.code ?? err.message}). Check DATABASE_URL / network.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function startWorker({ config, verifyToken, migrate, onShutdown }) {
  const pool = createPool(config);
  await assertDatabaseReachable(pool);
  if (migrate && config.autoMigrate) await runMigrations(pool, console);
  const app = await buildApp({ config, pool, verifyToken });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try { await app.close(); await pool.end(); await onShutdown?.(); } finally { process.exit(0); }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  return app;
}
