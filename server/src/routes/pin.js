// Phone + 4-digit PIN sign-in. The phone number was proven once with an SMS code (Firebase); after that the member
// signs in with phone + PIN and no SMS is needed. The Telegram bot uses the same endpoint (purpose: "bot").
import { phoneCheckBody, phoneRegisterBody, pinLoginBody } from '../lib/schemas.js';
import { HttpError, notFound, unauthorized, validationError } from '../lib/errors.js';
import { detail } from '../lib/validation.js';
import { phoneIdentity } from '../lib/identity.js';
import { withTx } from '../db.js';
import { publish } from '../events.js';
import { memberDto } from '../lib/dto.js';
import { burnPinCheck, hashPin, isWeakPin, signSession, verifyPin } from '../lib/pin.js';

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
    if (isWeakPin(body.pin)) throw validationError([detail('pin', 'pin_weak')]);
    const identity = phoneIdentity(body.phone);
    const hash = await hashPin({ secret: config.authSecret, identity, pin: body.pin });
    let row;
    try {
      row = await withTx(pool, async (db) => {
        const { rows: [m] } = await db.query(
          `INSERT INTO members (email, company, contact_name, phone, telegram, contact_email, status, login_phone, pin_hash, pin_changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'approved', $4, $7, now()) RETURNING *`,
          [identity, body.company || body.contactName, body.contactName, body.phone, body.telegram, body.contactEmail, hash]);
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

  // Trade a still-valid PIN session for a fresh one (the browser and the bot do this before theirs runs out).
  app.post('/api/auth/refresh', { preHandler: app.guards.authed, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    if (req.user.provider !== 'pin') throw notFound();
    return signSession({ secret: config.authSecret, identity: req.user.email, phone: req.user.phone, purpose: req.user.purpose });
  });
}
