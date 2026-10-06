import { accessRequestBody, profileBody } from '../lib/schemas.js';
import { memberDto } from '../lib/dto.js';
import { conflict, forbidden } from '../lib/errors.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';

export default async function meRoutes(app, { pool, config }) {
  // Who am I / what can I do? Works for any signed-in Google user, even before they have a request.
  app.get('/api/me', { preHandler: app.guards.authed }, async (req) => {
    const m = req.member;
    return {
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      status: m ? m.status : 'none',
      isOwner: m?.role === 'owner',
      profile: m ? memberDto(m) : null,
      ownerContact: config.ownerEmails[0] ?? null,
    };
  });

  // A new company asks for access. Idempotent per email: asking twice never creates duplicates.
  app.post('/api/me/access-request', {
    preHandler: app.guards.authed,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (req.member) throw conflict(`You already have an access request (${req.member.status})`, `already_${req.member.status}`);
    const body = accessRequestBody.parse(req.body);
    const row = await withTx(pool, async (db) => {
      const { rows: [created] } = await db.query(
        `INSERT INTO members (email, firebase_uid, company, contact_name, phone, telegram)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO NOTHING
         RETURNING *`,
        [req.user.email, req.user.uid, body.company, body.contactName || req.user.name, body.phone, body.telegram],
      );
      if (created) await publish(db, { entity: 'members', op: 'insert', id: created.id });
      return created;
    });
    app.invalidateMember(req.user.email);
    if (!row) throw conflict('You already have an access request', 'already_requested'); // lost a race
    return reply.code(201).send({ status: row.status, profile: memberDto(row) });
  });

  // Edit own profile. Company name is mirrored onto the member's live posts so lists stay consistent.
  app.patch('/api/me/profile', { preHandler: app.guards.approved }, async (req) => {
    const body = profileBody.parse(req.body);
    if (req.member.role === 'owner' && Object.keys(body).length === 0) throw forbidden('Nothing to update');
    const map = {
      company: 'company', contactName: 'contact_name', phone: 'phone', telegram: 'telegram', contactEmail: 'contact_email',
      location: 'location', tirCarnet: 'tir_carnet', fleet: 'fleet', routes: 'routes',
    };
    const sets = [];
    const params = [req.member.id];
    for (const [key, col] of Object.entries(map)) {
      if (body[key] !== undefined) { params.push(body[key]); sets.push(`${col} = $${params.length}`); }
    }
    if (sets.length === 0) return { profile: memberDto(req.member) };
    const row = await withTx(pool, async (db) => {
      const { rows: [updated] } = await db.query(
        `UPDATE members SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
      if (body.company !== undefined) {
        await db.query(`UPDATE loads  SET company_name = $2 WHERE owner_id = $1 AND status = 'active'`, [updated.id, updated.company]);
        await db.query(`UPDATE trucks SET company_name = $2 WHERE owner_id = $1 AND status = 'active'`, [updated.id, updated.company]);
        await publish(db, { entity: 'loads', op: 'bulk' });
        await publish(db, { entity: 'trucks', op: 'bulk' });
      }
      await publish(db, { entity: 'me', email: updated.email });
      return updated;
    });
    app.invalidateMember(row.email);
    return { profile: memberDto(row) };
  });
}
