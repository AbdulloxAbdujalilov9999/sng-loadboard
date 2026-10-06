import { adminMembersQuery, fxBody, idParam } from '../lib/schemas.js';
import { memberDto } from '../lib/dto.js';
import { notFound } from '../lib/errors.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';

// Owner-only moderation: approve / decline / revoke members, maintain display FX rates.
export default async function adminRoutes(app, { pool }) {
  const guard = { preHandler: app.guards.owner };

  app.get('/api/admin/members', guard, async (req) => {
    const { status } = adminMembersQuery.parse(req.query);
    const [{ rows }, { rows: counts }] = await Promise.all([
      pool.query(
        `SELECT * FROM members
          WHERE role = 'member' AND ($1 = 'all' OR status = $1)
          ORDER BY (status = 'pending') DESC, requested_at DESC
          LIMIT 500`, [status]),
      pool.query(`SELECT status, count(*)::int AS n FROM members WHERE role = 'member' GROUP BY status`),
    ]);
    const tally = { pending: 0, approved: 0, rejected: 0 };
    for (const c of counts) tally[c.status] = c.n;
    return { items: rows.map(memberDto), counts: tally };
  });

  async function decide(req, status) {
    const { id } = idParam.parse(req.params);
    const decided = await withTx(pool, async (db) => {
      const { rows: [m] } = await db.query(
        `UPDATE members SET status = $2, reviewed_at = now(), reviewed_by = $3, updated_at = now()
          WHERE id = $1 AND role = 'member' RETURNING *`, [id, status, req.member.id]);
      if (!m) throw notFound('Member not found');
      if (status !== 'approved') {
        // Declining/revoking takes the member's live posts off the board immediately.
        await db.query(`UPDATE loads  SET status = 'closed', closed_at = now() WHERE owner_id = $1 AND status = 'active'`, [id]);
        await db.query(`UPDATE trucks SET status = 'closed', closed_at = now() WHERE owner_id = $1 AND status = 'active'`, [id]);
        await publish(db, { entity: 'loads', op: 'bulk' });
        await publish(db, { entity: 'trucks', op: 'bulk' });
      }
      await publish(db, { entity: 'me', email: m.email });
      await publish(db, { entity: 'members', op: 'update', id });
      return m;
    });
    app.invalidateMember(decided.email);
    return decided;
  }

  app.post('/api/admin/members/:id/approve', guard, async (req) => ({ profile: memberDto(await decide(req, 'approved')) }));
  app.post('/api/admin/members/:id/reject', guard, async (req) => ({ profile: memberDto(await decide(req, 'rejected')) }));

  // Hard delete (e.g. spam). Their posts go with them; they may request access again afterwards.
  app.delete('/api/admin/members/:id', guard, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    let removedEmail;
    await withTx(pool, async (db) => {
      const { rows: [m] } = await db.query(`DELETE FROM members WHERE id = $1 AND role = 'member' RETURNING email`, [id]);
      if (!m) throw notFound('Member not found');
      removedEmail = m.email;
      await publish(db, { entity: 'loads', op: 'bulk' });
      await publish(db, { entity: 'trucks', op: 'bulk' });
      await publish(db, { entity: 'me', email: m.email });
      await publish(db, { entity: 'members', op: 'delete', id });
    });
    app.invalidateMember(removedEmail);
    return reply.code(204).send();
  });

  // Update display-currency rates (units per 1 USD). Only existing currency codes can be changed.
  app.put('/api/admin/fx', guard, async (req) => {
    const { rates } = fxBody.parse(req.body);
    const updated = await withTx(pool, async (db) => {
      let n = 0;
      for (const [code, perUsd] of Object.entries(rates)) {
        const r = await db.query('UPDATE fx_rates SET per_usd = $2, updated_at = now() WHERE code = $1', [code, perUsd]);
        n += r.rowCount;
      }
      if (n) await publish(db, { entity: 'fx', op: 'update' });
      return n;
    });
    return { updated };
  });
}
