// A member's saved load-search filters (web dashboard / Mini App): list, create, delete. Matching
// against newly-posted loads and sending the Telegram alert happen elsewhere - lib/savedSearchAlerts.js
// (called from routes/loads.js after a load is created) and bot/src/broadcaster.js.
import { idParam, savedSearchBody } from '../lib/schemas.js';
import { notFound, tooMany } from '../lib/errors.js';

const MAX_PER_MEMBER = 20;

export default async function savedSearchRoutes(app, { pool }) {
  const approved = { preHandler: app.guards.active };

  app.get('/api/me/saved-searches', approved, async (req) => {
    const { rows } = await pool.query(
      `SELECT id, name, filters, created_at FROM saved_searches WHERE member_id = $1 AND active ORDER BY id DESC`, [req.member.id]);
    return { items: rows };
  });

  app.post('/api/me/saved-searches', approved, async (req, reply) => {
    const body = savedSearchBody.parse(req.body);
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM saved_searches WHERE member_id = $1 AND active`, [req.member.id]);
    if (n >= MAX_PER_MEMBER) throw tooMany(`You have reached the limit of ${MAX_PER_MEMBER} saved searches. Remove one to save another.`);
    const { rows: [row] } = await pool.query(
      `INSERT INTO saved_searches (member_id, name, filters) VALUES ($1, $2, $3) RETURNING id, name, filters, created_at`,
      [req.member.id, body.name, JSON.stringify(body.filters)]);
    return reply.code(201).send(row);
  });

  app.delete('/api/me/saved-searches/:id', approved, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await pool.query(`DELETE FROM saved_searches WHERE id = $1 AND member_id = $2`, [id, req.member.id]);
    if (!rowCount) throw notFound('Saved search not found');
    return { ok: true };
  });
}
