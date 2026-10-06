import pg from 'pg';

// Return numbers/dates in shapes the API (and JSON) can use directly:
//  int8 -> number (ids/counts stay far below 2^53), date -> 'YYYY-MM-DD' string (no TZ shifting).
// numeric stays a string (exact) and is converted explicitly where needed.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export function createPool(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'sng-one-api',
    // Protects the pool: no single runaway query can hold a connection for long.
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: 15_000,
  });
  pool.on('error', (err) => {
    // An idle client erroring (e.g. DB restart) must not crash the process; the pool replaces it.
    console.error('pg pool idle client error:', err.message);
  });
  return pool;
}

export async function withTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}
