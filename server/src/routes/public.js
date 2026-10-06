export default async function publicRoutes(app, { pool, config }) {
  // Liveness + DB readiness for load balancers / orchestrators.
  app.get('/healthz', async (req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  // Public bootstrap data the UI needs before anyone signs in: display currencies + enums.
  app.get('/api/config', async (req, reply) => {
    const { rows } = await pool.query('SELECT code, symbol, per_usd, updated_at FROM fx_rates ORDER BY code');
    reply.header('Cache-Control', 'public, max-age=10');
    return {
      currencies: Object.fromEntries(rows.map((r) => [r.code.trim(), { symbol: r.symbol, rate: Number(r.per_usd) }])),
      ratesUpdatedAt: rows.reduce((max, r) => (r.updated_at > max ? r.updated_at : max), rows[0]?.updated_at ?? null),
      equipTypes: ['T', 'R', 'F', 'V', 'AC'],
      roadFactor: config.roadFactor,
      ownerContact: config.ownerEmails[0] ?? null,
      devAuth: config.devAuth, // true only for the local dev server: lets the UI offer a fake sign-in
    };
  });
}
