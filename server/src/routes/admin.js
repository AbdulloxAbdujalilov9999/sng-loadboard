import { activateBody, adminMembersQuery, fxBody, idParam, subscriptionBody } from '../lib/schemas.js';
import { loadSettings, stateOf } from '../lib/subscription.js';
import { memberDto } from '../lib/dto.js';
import { notFound } from '../lib/errors.js';
import crypto from 'node:crypto';
import { hashPin, isObviousPin } from '../lib/pin.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';

// Owner-only moderation: approve / decline / revoke members, maintain display FX rates.
export default async function adminRoutes(app, { pool, config }) {
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
    const settings = await app.subscriptionSettings();
    return { items: rows.map((m) => ({ ...memberDto(m), subscription: stateOf(m, settings) })), counts: tally, subscriptionEnabled: settings.enabled };
  });

  // ---- subscriptions (managed by hand: the owner adds paid time after the member pays)
  app.get('/api/admin/subscription', guard, async () => loadSettings(pool));

  app.put('/api/admin/subscription', guard, async (req) => {
    const body = subscriptionBody.parse(req.body);
    const cur = await loadSettings(pool);
    // The first time it is switched on, members who joined earlier get their trial from that moment (not from their sign-up).
    const next = { ...body, enabledAt: cur.enabledAt ?? (body.enabled ? new Date().toISOString() : null) };
    await withTx(pool, async (db) => {
      await db.query(`INSERT INTO app_settings (key, value) VALUES ('subscription', $1::jsonb)
                      ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`, [JSON.stringify(next)]);
      await publish(db, { entity: 'settings' });
    });
    return next;
  });

  // Add paid time (from now, or on top of what is left). The member's open app unlocks at once.
  app.post('/api/admin/members/:id/subscription', guard, async (req) => {
    const { id } = idParam.parse(req.params);
    const { days } = activateBody.parse(req.body);
    const m = await withTx(pool, async (db) => {
      const { rows: [row] } = await db.query(
        `UPDATE members SET paid_until = GREATEST(COALESCE(paid_until, now()), now()) + make_interval(days => $2), updated_at = now()
          WHERE id = $1 AND role = 'member' RETURNING *`, [id, days]);
      if (!row) throw notFound('Member not found');
      await publish(db, { entity: 'me', email: row.email });
      await publish(db, { entity: 'members', op: 'update', id });
      return row;
    });
    app.invalidateMember(m.email);
    return { subscription: stateOf(m, await loadSettings(pool)) };
  });

  // End a member's access now (paid time and trial).
  app.delete('/api/admin/members/:id/subscription', guard, async (req) => {
    const { id } = idParam.parse(req.params);
    const m = await withTx(pool, async (db) => {
      const { rows: [row] } = await db.query(
        `UPDATE members SET paid_until = NULL, trial_ends_at = now() - interval '1 second', updated_at = now()
          WHERE id = $1 AND role = 'member' RETURNING *`, [id]);
      if (!row) throw notFound('Member not found');
      await publish(db, { entity: 'me', email: row.email });
      await publish(db, { entity: 'members', op: 'update', id });
      return row;
    });
    app.invalidateMember(m.email);
    return { subscription: stateOf(m, await loadSettings(pool)) };
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

  // "I forgot my password": there is no SMS, so the owner issues a new random 6-digit password, shown ONCE, and passes it to the
  // member (phone / Telegram). It ends all their other sessions (web + Telegram bot); they should change it after signing in.
  app.post('/api/admin/members/:id/reset-pin', guard, async (req) => {
    const { id } = idParam.parse(req.params);
    if (!config.authSecret) throw notFound('Password sign-in is not enabled');
    const { rows: [m] } = await pool.query("SELECT id, email, login_phone FROM members WHERE id = $1 AND role = 'member'", [id]);
    if (!m || !m.login_phone) throw notFound('This member has no phone sign-in');
    let pin;
    do { pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'); } while (isObviousPin(pin));
    const hash = await hashPin({ secret: config.authSecret, identity: m.email, pin });
    await withTx(pool, async (db) => {
      await db.query('UPDATE members SET pin_hash = $2, pin_changed_at = now(), pin_fails = 0, pin_locked_until = NULL, updated_at = now() WHERE id = $1', [id, hash]);
      await publish(db, { entity: 'me', email: m.email });
    });
    app.invalidateMember(m.email);
    return { pin, phone: m.login_phone };
  });

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
