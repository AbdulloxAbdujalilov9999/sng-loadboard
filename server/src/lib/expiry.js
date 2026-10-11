import { publish } from '../events.js';
import { withTx } from '../db.js';

// Loads leave the board by themselves `hours` after they were posted (default 14 days: most people never set a load date,
// and nobody posts freight more than two weeks ahead).
// The owner can switch it off or change the time; the owner's choice lives in app_settings under 'loadExpiry'.
export const DEFAULTS = { enabled: true, hours: 336 };
const LOCK_KEY = [1016, 1]; // two-int advisory-lock namespace: never collides with the per-member (single bigint) locks

export async function loadExpirySettings(pool) {
  const { rows: [r] } = await pool.query("SELECT value FROM app_settings WHERE key = 'loadExpiry'");
  return { ...DEFAULTS, ...(r?.value ?? {}) };
}

/** What members may see: just whether loads expire and after how long (0 = never). */
export const publicExpiry = (s) => ({ enabled: Boolean(s.enabled), hours: s.enabled ? s.hours : 0 });

/**
 * Closes every active load older than the limit. Safe to run on every worker and every instance at once: only the
 * one that takes the advisory lock does the work. Returns how many loads were closed.
 */
export async function sweepExpiredLoads(pool) {
  const settings = await loadExpirySettings(pool);
  if (!settings.enabled) return 0;
  return withTx(pool, async (db) => {
    const { rows: [lock] } = await db.query('SELECT pg_try_advisory_xact_lock($1, $2) AS ok', LOCK_KEY);
    if (!lock.ok) return 0;
    const { rowCount } = await db.query(
      `UPDATE loads SET status = 'closed', closed_at = now(), updated_at = now()
        WHERE status = 'active' AND created_at <= now() - make_interval(hours => $1::int)`, [settings.hours]);
    if (rowCount) await publish(db, { entity: 'loads', op: 'bulk' });
    return rowCount;
  });
}

/** Forgets posts that were closed (removed or expired) more than `days` ago, so the tables don't grow without end. */
export async function purgeClosedPosts(pool, days = 90) {
  return withTx(pool, async (db) => {
    const { rows: [lock] } = await db.query('SELECT pg_try_advisory_xact_lock($1, $2) AS ok', [1016, 2]);
    if (!lock.ok) return 0;
    const a = await db.query(`DELETE FROM loads  WHERE status = 'closed' AND closed_at < now() - make_interval(days => $1::int)`, [days]);
    const b = await db.query(`DELETE FROM trucks WHERE status = 'closed' AND closed_at < now() - make_interval(days => $1::int)`, [days]);
    return a.rowCount + b.rowCount;
  });
}

/** Runs the sweep every `everyMs` (and once right away). The returned function stops it. Errors are logged, never thrown. */
export function startExpirySweeper(pool, { everyMs = 60_000, log = console } = {}) {
  let busy = false;
  let lastPurge = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const n = await sweepExpiredLoads(pool);
      if (n) log.info?.(`expired ${n} load(s)`);
      if (Date.now() - lastPurge > 3_600_000) { lastPurge = Date.now(); const p = await purgeClosedPosts(pool); if (p) log.info?.(`purged ${p} old closed post(s)`); }
    } catch (err) { log.warn?.(`load expiry sweep failed: ${err.message}`); } finally { busy = false; }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  setTimeout(tick, 2000).unref();
  return () => clearInterval(timer);
}
