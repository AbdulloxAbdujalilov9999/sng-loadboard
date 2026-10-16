import { createRemoteJWKSet, jwtVerify } from 'jose';
import { HttpError, forbidden, unauthorized } from './lib/errors.js';
import { loadSettings, stateOf } from './lib/subscription.js';
import { loadExpirySettings } from './lib/expiry.js';
import { TtlCache } from './lib/ttl.js';
import { phoneIdentity } from './lib/identity.js';
import { isOwnToken, verifySession } from './lib/pin.js';
import { verifyTelegramSession } from './lib/telegramSession.js';

const FIREBASE_JWKS = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

/**
 * Verifies a Firebase Auth ID token (the thing the browser gets after "Continue with Google").
 * Only public Google signing keys are needed - there is no service-account secret to manage.
 */
export function createFirebaseVerifier({ projectId, keySet }) {
  // `keySet` is injectable so tests can sign tokens with their own key; production uses Google's.
  const jwks = keySet ?? createRemoteJWKSet(new URL(FIREBASE_JWKS), { cooldownDuration: 30_000, cacheMaxAge: 3_600_000 });
  return async function verifyToken(token) {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });
    if (!payload.sub) throw new Error('token has no subject');
    const provider = payload.firebase?.sign_in_provider;
    const name = typeof payload.name === 'string' ? payload.name : '';
    const picture = typeof payload.picture === 'string' ? payload.picture : '';

    if (provider === 'phone') {
      // Phone numbers are verified by the SMS code itself; there is no e-mail on these tokens.
      const phone = payload.phone_number;
      if (typeof phone !== 'string' || !/^\+\d{8,15}$/.test(phone)) throw new Error('bad phone number');
      return { uid: payload.sub, email: phoneIdentity(phone), loginEmail: '', phone, provider, name, picture };
    }
    if (provider !== 'google.com' && provider !== 'password') throw new Error('unsupported sign-in provider');
    // E-mail + password accounts can be created for ANY address, so the mailbox must be proven first - otherwise
    // someone could register the owner's address and become the owner.
    if (typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('email not verified');
    const email = payload.email.toLowerCase();
    // A Google / e-mail account that has linked a phone (verified by SMS) carries it in the token: that is how a member adds a sign-in phone.
    const linked = typeof payload.phone_number === 'string' && /^\+\d{8,15}$/.test(payload.phone_number) ? payload.phone_number : '';
    return { uid: payload.sub, email, loginEmail: email, phone: linked, provider, name, picture };
  };
}

/**
 * Registers request decoration + reusable guard chains:
 *   guards.authed   - valid token; req.member is the DB row (or null if they never requested access)
 *   guards.approved - authed AND an approved member (or the owner)
 *   guards.owner    - authed AND the platform owner
 * The owner is defined by the OWNER_EMAILS env var (never by client data) and is auto-provisioned.
 */
export function registerAuth(app, { config, pool, verifyToken: verifyExternal, hub }) {
  // Three kinds of sessions: Firebase ID tokens (Google / e-mail / SMS code), the ones this server issues after a
  // phone + PIN sign-in (see lib/pin.js), and the ones it issues after a Telegram Mini App sign-in (see
  // lib/telegramSession.js). A Firebase token is routed by its signing algorithm (RS256 vs our own HS256); the two
  // kinds of HS256 session share an algorithm but use different JWT audiences, so a failed PIN-audience check falls
  // through to the Telegram one.
  const verifyToken = async (token) => {
    if (!isOwnToken(token)) return verifyExternal(token);
    if (!config.authSecret) throw new Error('Session sign-in is not enabled');
    try {
      const s = await verifySession({ secret: config.authSecret, token });
      if (!/^\+\d{8,15}$/.test(s.phone)) throw new Error('bad session token');
      // The identity is whichever member owns that sign-in phone (a phone-only member, or a Google member who added one).
      return { uid: `pin:${s.identity}`, email: s.identity, loginEmail: '', phone: s.phone, provider: 'pin', name: '', picture: '', iat: s.iat, purpose: s.purpose };
    } catch {
      const s = await verifyTelegramSession({ secret: config.authSecret, token });
      return { uid: `tg:${s.identity}`, email: s.identity, loginEmail: '', phone: '', provider: 'telegram', name: '', picture: '', iat: s.iat, telegramUserId: s.telegramUserId };
    }
  };
  app.decorateRequest('user', null);
  app.decorateRequest('member', null);

  // Every request needs the caller's membership row. Cache it briefly; it is dropped immediately when
  // an admin decision / profile change is announced (Postgres NOTIFY reaches every API instance), and
  // wholesale after a listener reconnect. The TTL is only a safety net.
  const memberCache = new TtlCache({ ttlMs: config.memberCacheMs, max: 5000 });
  app.decorate('invalidateMember', (email) => memberCache.delete(email));
  // Fresh status/role for one identity (used to keep open live streams in step with approvals, blocks and sign-ups).
  app.decorate('memberStatusOf', async (email) => (await pool.query('SELECT status, role FROM members WHERE email = $1', [email])).rows[0] ?? null);
  hub?.observe((evt) => {
    if (evt.entity === 'me') memberCache.delete(evt.email);
    else if (evt.entity === 'resync') memberCache.clear();
  });

  async function authenticate(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice(7).trim();
    if (!token || token.length > 4096) throw unauthorized();
    try {
      req.user = await verifyToken(token);
    } catch (err) {
      req.log.debug({ err: err.message }, 'token verification failed');
      throw unauthorized('Invalid or expired session');
    }
  }

  async function resolveMember({ email, uid, name }) {
    const isOwnerEmail = config.ownerEmails.includes(email);
    let { rows: [member] } = await pool.query({ name: 'member_by_email', text: 'SELECT * FROM members WHERE email = $1', values: [email] });

    if (isOwnerEmail && (!member || member.role !== 'owner' || member.status !== 'approved')) {
      ({ rows: [member] } = await pool.query(
        `INSERT INTO members (email, firebase_uid, company, contact_name, status, role, reviewed_at)
         VALUES ($1, $2, 'SNG ONE Platform', $3, 'approved', 'owner', now())
         ON CONFLICT (email) DO UPDATE SET role = 'owner', status = 'approved', reviewed_at = now()
         RETURNING *`, [email, uid, name]));
    } else if (member && member.role === 'owner' && !isOwnerEmail) {
      // Owner list is the source of truth: removing an email from OWNER_EMAILS demotes them.
      ({ rows: [member] } = await pool.query(
        `UPDATE members SET role = 'member' WHERE id = $1 RETURNING *`, [member.id]));
    }
    if (member && !member.firebase_uid) {
      await pool.query('UPDATE members SET firebase_uid = $2 WHERE id = $1 AND firebase_uid IS NULL', [member.id, uid])
        .catch(() => { /* uid already bound to another row; email remains the identity */ });
    }
    return member ?? null;
  }

  // A verified phone belongs to exactly one member. After an SMS sign-in, the member is whoever registered that number
  // (their own phone identity, or the Google / e-mail account that linked it), so every way in leads to the same account.
  const phoneOwner = new TtlCache({ ttlMs: config.memberCacheMs, max: 5000 });
  hub?.observe((evt) => { if (evt.entity === 'me' || evt.entity === 'resync') phoneOwner.clear(); });

  // Subscription settings (a few seconds of cache; cleared at once when the owner saves them, on any instance).
  const subCache = new TtlCache({ ttlMs: Math.min(config.memberCacheMs, 5000), max: 4 });
  hub?.observe((evt) => { if (evt.entity === 'settings' || evt.entity === 'resync') subCache.clear(); });
  app.decorate('subscriptionSettings', () => subCache.getOrLoad('s', () => loadSettings(pool)));
  app.decorate('loadExpiry', () => subCache.getOrLoad('expiry', () => loadExpirySettings(pool)));

  async function loadMember(req) {
    if (req.user.provider === 'phone') {
      const identity = await phoneOwner.getOrLoad(req.user.phone, async () => (await pool.query('SELECT email FROM members WHERE login_phone = $1', [req.user.phone])).rows[0]?.email ?? '');
      if (identity) req.user.email = identity;
    }
    req.member = await memberCache.getOrLoad(req.user.email, () => resolveMember(req.user));
    if (req.user.provider === 'pin') {
      // A PIN session ends the moment the PIN is changed or removed (the token carries its issue time).
      const m = req.member;
      const changed = m?.pin_changed_at ? Math.floor(new Date(m.pin_changed_at).getTime() / 1000) : 0;
      if (!m || !m.pin_hash || req.user.iat < changed) throw unauthorized('Invalid or expired session');
    }
  }

  // Hooks must be async (or call done): a sync hook that returns normally would hang the request.
  async function requireApproved(req) {
    if (!req.member) throw forbidden('Request access first', 'no_account');
    if (req.member.status !== 'approved') {
      throw forbidden(`Your access request is ${req.member.status}`, `not_approved_${req.member.status}`);
    }
  }

  // The marketplace is for members whose free trial or paid time has not run out. Profile and sign-in routes use `approved`.
  async function requireActive(req) {
    const st = stateOf(req.member, await app.subscriptionSettings());
    if (st.state === 'expired') throw new HttpError(402, 'subscription_required', 'Your free trial or subscription has ended');
  }

  async function requireOwner(req) {
    if (req.member?.role !== 'owner') throw forbidden('Owner only', 'owner_only');
  }

  const guards = {
    authed: [authenticate, loadMember],
    approved: [authenticate, loadMember, requireApproved],
    active: [authenticate, loadMember, requireApproved, requireActive],
    owner: [authenticate, loadMember, requireOwner],
  };
  app.decorate('guards', guards);
  return guards;
}
