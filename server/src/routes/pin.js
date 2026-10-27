// Phone + 4-digit PIN sign-in. The phone number was proven once with an SMS code (Firebase); after that the member
// signs in with phone + PIN and no SMS is needed. The Telegram bot uses the same endpoint (purpose: "bot").
import { createHash, randomBytes } from 'node:crypto';
import { linkLoginBody, phoneCheckBody, phoneRegisterBody, pinLoginBody } from '../lib/schemas.js';
import { HttpError, forbidden, notFound, unauthorized, validationError } from '../lib/errors.js';
import { detail } from '../lib/validation.js';
import { phoneIdentity } from '../lib/identity.js';
import { withTx } from '../db.js';
import { publish } from '../events.js';
import { memberDto } from '../lib/dto.js';
import { trialEndFor } from '../lib/subscription.js';
import { referrerId } from '../lib/growth.js';
import { burnPinCheck, hashPin, signSession, verifyPin } from '../lib/pin.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export default async function pinRoutes(app, { pool, config }) {
  const enabled = Boolean(config.authSecret);
  const off = () => new HttpError(404, 'pin_disabled', 'PIN sign-in is not enabled');

  // Does this phone number sign in with a PIN? (Tells the sign-in form whether to ask for the PIN or send an SMS code.)
  app.post('/api/auth/phone/check', { config: { rateLimit: { max: config.pinLoginPerMin * 3, timeWindow: '1 minute' } } }, async (req) => {
    if (!enabled) return { exists: false, hasPin: false };
    const { phone } = phoneCheckBody.parse(req.body);
    const { rows: [m] } = await pool.query("SELECT pin_hash IS NOT NULL AS has_pin FROM members WHERE login_phone = $1 AND role = 'member'", [phone]);
    return { exists: Boolean(m?.has_pin), hasPin: Boolean(m?.has_pin) };
  });

  // Create an account with a phone number + a 4-6 digit password. No SMS: the number is NOT verified, so the owner can reset
  // or remove any account, and creating accounts is rate-limited per IP.
  app.post('/api/auth/phone/register', { config: { rateLimit: { max: config.registerPerHour, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (!enabled) throw off();
    const body = phoneRegisterBody.parse(req.body);
    const identity = phoneIdentity(body.phone);
    const hash = await hashPin({ secret: config.authSecret, identity, pin: body.pin });
    let row;
    try {
      row = await withTx(pool, async (db) => {
        const { rows: [m] } = await db.query(
          `INSERT INTO members (email, company, contact_name, phone, telegram, contact_email, status, login_phone, pin_hash, pin_changed_at, works_with_company, trial_ends_at, persona, referred_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'approved', $4, $7, now(), $8, $9, $10, $11) RETURNING *`,
          [identity, body.company || body.contactName, body.contactName, body.phone, body.telegram, body.contactEmail, hash, Boolean(body.company), trialEndFor(await app.subscriptionSettings()), body.persona ?? null, await referrerId(db, body.ref)]);
        await publish(db, { entity: 'members', op: 'insert', id: m.id });
        return m;
      });
    } catch (err) {
      if (err.code === '23505') throw validationError([detail('phone', 'phone_taken')]); // that number already has an account
      throw err;
    }
    const session = await signSession({ secret: config.authSecret, identity, phone: body.phone, purpose: 'web' });
    return reply.code(201).send({ ...session, status: row.status, profile: memberDto(row) });
  });

  app.post('/api/auth/pin/login', { config: { rateLimit: { max: config.pinLoginPerMin, timeWindow: '1 minute' } } }, async (req) => {
    if (!enabled) throw off();
    const { phone, pin, purpose } = pinLoginBody.parse(req.body);
    // The member who registered this sign-in phone (a phone-only member, or a Google / e-mail member who added one).
    // The owner never signs in with a PIN: that account is protected by its verified e-mail.
    const { rows: [m] } = await pool.query(
      "SELECT id, email, status, pin_hash, pin_fails, pin_locked_until FROM members WHERE login_phone = $1 AND role = 'member'", [phone]);
    if (!m || !m.pin_hash) {
      await burnPinCheck(config.authSecret); // same time as a real check: nobody can probe which numbers exist
      throw unauthorized('Wrong phone number or PIN');
    }
    if (m.pin_locked_until && new Date(m.pin_locked_until) > new Date()) {
      const retryAfterSec = Math.ceil((new Date(m.pin_locked_until) - Date.now()) / 1000);
      throw new HttpError(429, 'pin_locked', `Too many wrong PINs. Try again in ${Math.ceil(retryAfterSec / 60)} min, or sign in with an SMS code.`, [{ path: 'pin', code: 'pin_locked', params: { min: Math.ceil(retryAfterSec / 60) } }]);
    }
    const ok = await verifyPin({ secret: config.authSecret, identity: m.email, pin, stored: m.pin_hash });
    if (!ok) {
      // Atomic: concurrent guesses cannot slip past the counter.
      await pool.query(
        `UPDATE members SET
            pin_fails = CASE WHEN pin_fails + 1 >= $2 THEN 0 ELSE pin_fails + 1 END,
            pin_locked_until = CASE WHEN pin_fails + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE pin_locked_until END
          WHERE id = $1`, [m.id, MAX_FAILS, LOCK_MINUTES]);
      throw unauthorized('Wrong phone number or PIN');
    }
    if (m.pin_fails) await pool.query('UPDATE members SET pin_fails = 0, pin_locked_until = NULL WHERE id = $1', [m.id]);
    const session = await signSession({ secret: config.authSecret, identity: m.email, phone, purpose });
    return { ...session, status: m.status };
  });

  // ---- "open the website, already signed in": a one-time link made from the Telegram bot ----
  const LINK_MINUTES = 15;
  const hashOf = (code) => createHash('sha256').update(code).digest('hex');

  // The signed-in member (the bot calls this with the member's own session) gets a code that opens the website as them, once.
  app.post('/api/me/login-link', { preHandler: app.guards.approved, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!enabled) throw off();
    const m = req.member;
    if (!m.login_phone || m.role === 'owner') throw forbidden('Not available for this account', 'pin_not_for_provider'); // sessions of this kind belong to phone members
    const code = randomBytes(32).toString('base64url');
    const { rows: [row] } = await pool.query(
      `INSERT INTO login_links (code_hash, member_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at`, [hashOf(code), m.id, LINK_MINUTES]);
    pool.query("DELETE FROM login_links WHERE expires_at < now() - interval '1 day'").catch(() => {});
    return { code, expiresAt: row.expires_at };
  });

  // Trade the code for a normal web session. Atomic: of two requests with the same code only one wins.
  app.post('/api/auth/link-login', { config: { rateLimit: { max: config.pinLoginPerMin, timeWindow: '1 minute' } } }, async (req) => {
    if (!enabled) throw off();
    const { code } = linkLoginBody.parse(req.body);
    const { rows: [link] } = await pool.query(
      'UPDATE login_links SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING member_id', [hashOf(code)]);
    if (!link) throw unauthorized('Invalid or expired link');
    const { rows: [m] } = await pool.query("SELECT email, login_phone, status FROM members WHERE id = $1 AND role = 'member' AND login_phone IS NOT NULL", [link.member_id]);
    if (!m || m.status !== 'approved') throw unauthorized('Invalid or expired link');
    const session = await signSession({ secret: config.authSecret, identity: m.email, phone: m.login_phone, purpose: 'web' });
    return { ...session, status: m.status, phone: m.login_phone };
  });

  // Trade a still-valid PIN session for a fresh one (the browser and the bot do this before theirs runs out).
  app.post('/api/auth/refresh', { preHandler: app.guards.authed, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    if (req.user.provider !== 'pin') throw notFound();
    return signSession({ secret: config.authSecret, identity: req.user.email, phone: req.user.phone, purpose: req.user.purpose });
  });
}
