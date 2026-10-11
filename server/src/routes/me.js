import { pinBody, profileBody, signupBody } from '../lib/schemas.js';
import { memberDto } from '../lib/dto.js';
import { conflict, forbidden, validationError } from '../lib/errors.js';
import { detail } from '../lib/validation.js';
import { hashPin, isWeakPin, signSession, verifyPin } from '../lib/pin.js';
import { loginLabel } from '../lib/identity.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';

export default async function meRoutes(app, { pool, config }) {
  // Who am I / what can I do? Works for any signed-in Google user, even before they have a request.
  app.get('/api/me', { preHandler: app.guards.authed }, async (req) => {
    const m = req.member;
    return {
      email: req.user.loginEmail,                 // real e-mail ('' for phone sign-in)
      login: loginLabel(req.user.email),          // what to show as "you sign in with": e-mail or +phone
      provider: req.user.provider,
      name: req.user.name,
      picture: req.user.picture,
      status: m ? m.status : 'none',
      isOwner: m?.role === 'owner',
      profile: m ? memberDto(m) : null,
      ownerContact: config.ownerEmails[0] ?? null,
    };
  });

  // Sign up: the person is a member straight away (no approval step). A name and one way to be reached are required;
  // everything else (company, e-mail) can be added later in Settings. Idempotent per identity.
  app.post('/api/me/access-request', {
    preHandler: app.guards.authed,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (req.member) throw conflict(`You already have an account (${req.member.status})`, `already_${req.member.status}`);
    const body = signupBody.parse(req.body);
    const bySms = req.user.provider === 'phone';
    const phone = body.phone || (bySms ? req.user.phone : '');
    if (!phone && !body.telegram) throw validationError([detail('phone', 'contact_required'), detail('telegram', 'contact_required')]);

    // Phone sign-ups choose a 4-digit PIN, so next time they sign in with phone + PIN (no SMS code).
    let pinHash = null;
    if (bySms && config.authSecret) {
      if (!body.pin) throw validationError([detail('pin', 'required')]);
      if (isWeakPin(body.pin)) throw validationError([detail('pin', 'pin_weak')]);
      pinHash = await hashPin({ secret: config.authSecret, identity: req.user.email, pin: body.pin });
    }
    const row = await withTx(pool, async (db) => {
      const { rows: [created] } = await db.query(
        `INSERT INTO members (email, firebase_uid, company, contact_name, phone, telegram, contact_email, status, pin_hash, pin_changed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END)
         ON CONFLICT (email) DO NOTHING
         RETURNING *`,
        [req.user.email, req.user.uid, body.company || body.contactName, body.contactName, phone, body.telegram,
          req.user.loginEmail ? '' : body.contactEmail, pinHash],
      );
      if (created) {
        await publish(db, { entity: 'members', op: 'insert', id: created.id });
        await publish(db, { entity: 'me', email: created.email });
      }
      return created;
    });
    app.invalidateMember(req.user.email);
    if (!row) throw conflict('You already have an account', 'already_requested'); // lost a race
    return reply.code(201).send({ status: row.status, profile: memberDto(row) });
  });

  // Set or change the 4-digit PIN. Allowed right after an SMS-code sign-in (that also covers "forgot my PIN"),
  // or with the current PIN. Google / e-mail accounts do not use PINs.
  app.put('/api/me/pin', {
    preHandler: app.guards.approved,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req) => {
    if (!config.authSecret) throw forbidden('PIN sign-in is not enabled on this server', 'pin_disabled');
    const body = pinBody.parse(req.body);
    const provider = req.user.provider;
    if (provider !== 'phone' && provider !== 'pin') throw forbidden('PINs are for phone sign-in only', 'pin_not_for_provider');
    if (isWeakPin(body.pin)) throw validationError([detail('pin', 'pin_weak')]);
    if (provider === 'pin') {
      if (!body.currentPin) throw validationError([detail('currentPin', 'required')]);
      const ok = await verifyPin({ secret: config.authSecret, identity: req.user.email, pin: body.currentPin, stored: req.member.pin_hash });
      if (!ok) throw validationError([detail('currentPin', 'pin_wrong')]);
    }
    const hash = await hashPin({ secret: config.authSecret, identity: req.user.email, pin: body.pin });
    const row = await withTx(pool, async (db) => {
      const { rows: [m] } = await db.query(
        `UPDATE members SET pin_hash = $2, pin_changed_at = now(), pin_fails = 0, pin_locked_until = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`, [req.member.id, hash]);
      await publish(db, { entity: 'me', email: m.email });
      return m;
    });
    app.invalidateMember(row.email);
    // Changing the PIN ends every older PIN session (other devices, the Telegram bot); this device gets a fresh one.
    const fresh = provider === 'pin' ? await signSession({ secret: config.authSecret, identity: row.email, phone: req.user.phone, purpose: req.user.purpose }) : null;
    return { ok: true, hasPin: true, ...(fresh ? { token: fresh.token, expiresAt: fresh.expiresAt } : {}) };
  });

  // Edit own profile. The company name is mirrored onto the member's live posts so lists stay consistent.
  app.patch('/api/me/profile', { preHandler: app.guards.approved }, async (req) => {
    const body = profileBody.parse(req.body);
    if (req.member.role === 'owner' && Object.keys(body).length === 0) throw forbidden('Nothing to update');
    const map = {
      company: 'company', contactName: 'contact_name', phone: 'phone', telegram: 'telegram', contactEmail: 'contact_email',
      location: 'location', tirCarnet: 'tir_carnet', fleet: 'fleet', routes: 'routes',
    };
    // No company? The person's name stands in. A phone or Telegram username must always remain.
    if (body.company === '') body.company = body.contactName || req.member.contact_name || req.member.company;
    const phoneAfter = body.phone === undefined ? req.member.phone : body.phone;
    const tgAfter = body.telegram === undefined ? req.member.telegram : body.telegram;
    if (!phoneAfter && !tgAfter) throw validationError([detail('phone', 'contact_required'), detail('telegram', 'contact_required')]);
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
