// Phone + 4-digit PIN sign-in. The phone number was proven once with an SMS code (Firebase); after that the member
// signs in with phone + PIN and no SMS is needed. The Telegram bot uses the same endpoint (purpose: "bot").
import { phoneCheckBody, pinLoginBody } from '../lib/schemas.js';
import { HttpError, notFound, unauthorized } from '../lib/errors.js';
import { phoneIdentity } from '../lib/identity.js';
import { burnPinCheck, signSession, verifyPin } from '../lib/pin.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export default async function pinRoutes(app, { pool, config }) {
  const enabled = Boolean(config.authSecret);
  const off = () => new HttpError(404, 'pin_disabled', 'PIN sign-in is not enabled');

  // Does this phone number sign in with a PIN? (Tells the sign-in form whether to ask for the PIN or send an SMS code.)
  app.post('/api/auth/phone/check', { config: { rateLimit: { max: config.pinLoginPerMin * 3, timeWindow: '1 minute' } } }, async (req) => {
    if (!enabled) return { hasPin: false };
    const { phone } = phoneCheckBody.parse(req.body);
    const { rows: [m] } = await pool.query('SELECT pin_hash IS NOT NULL AS has_pin FROM members WHERE email = $1', [phoneIdentity(phone)]);
    return { hasPin: Boolean(m?.has_pin) };
  });

  app.post('/api/auth/pin/login', { config: { rateLimit: { max: config.pinLoginPerMin, timeWindow: '1 minute' } } }, async (req) => {
    if (!enabled) throw off();
    const { phone, pin, purpose } = pinLoginBody.parse(req.body);
    const identity = phoneIdentity(phone);
    const { rows: [m] } = await pool.query(
      'SELECT id, email, status, pin_hash, pin_fails, pin_locked_until FROM members WHERE email = $1', [identity]);
    if (!m || !m.pin_hash) {
      await burnPinCheck(config.authSecret); // same time as a real check: nobody can probe which numbers exist
      throw unauthorized('Wrong phone number or PIN');
    }
    if (m.pin_locked_until && new Date(m.pin_locked_until) > new Date()) {
      const retryAfterSec = Math.ceil((new Date(m.pin_locked_until) - Date.now()) / 1000);
      throw new HttpError(429, 'pin_locked', `Too many wrong PINs. Try again in ${Math.ceil(retryAfterSec / 60)} min, or sign in with an SMS code.`, [{ path: 'pin', code: 'pin_locked', params: { min: Math.ceil(retryAfterSec / 60) } }]);
    }
    const ok = await verifyPin({ secret: config.authSecret, identity, pin, stored: m.pin_hash });
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
    const session = await signSession({ secret: config.authSecret, identity, phone, purpose });
    return { ...session, status: m.status };
  });

  // Trade a still-valid PIN session for a fresh one (the browser and the bot do this before theirs runs out).
  app.post('/api/auth/refresh', { preHandler: app.guards.authed, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    if (req.user.provider !== 'pin') throw notFound();
    return signSession({ secret: config.authSecret, identity: req.user.email, phone: req.user.phone, purpose: req.user.purpose });
  });
}
