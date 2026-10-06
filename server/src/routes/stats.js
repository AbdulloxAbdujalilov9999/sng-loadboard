const CAP = 10_000;

// Headline numbers for the navigation badges: how many live loads / trucks are on the board right now.
// Counted with the same cap as search totals and cached, so a busy dashboard costs one query per few seconds.
export default async function statsRoutes(app, { pool }) {
  app.get('/api/stats', { preHandler: app.guards.approved }, async () => {
    const one = async (sql) => {
      const { rows: [r] } = await app.countCache.getOrLoad(sql, () => pool.query(sql));
      return { count: Math.min(r.n, CAP), capped: r.n > CAP };
    };
    const [loads, trucks] = await Promise.all([
      one(`SELECT count(*)::int AS n FROM (SELECT 1 FROM loads WHERE status = 'active' AND pickup_date >= current_date - 1 LIMIT ${CAP + 1}) x`),
      one(`SELECT count(*)::int AS n FROM (SELECT 1 FROM trucks WHERE status = 'active' AND expires_on >= current_date LIMIT ${CAP + 1}) x`),
    ]);
    return { loads: loads.count, loadsCapped: loads.capped, trucks: trucks.count, trucksCapped: trucks.capped };
  });
}
