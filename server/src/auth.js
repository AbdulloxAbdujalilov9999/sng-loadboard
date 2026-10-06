import { createRemoteJWKSet, jwtVerify } from 'jose';
import { forbidden, unauthorized } from './lib/errors.js';
import { TtlCache } from './lib/ttl.js';
import { phoneIdentity } from './lib/identity.js';

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
    return { uid: payload.sub, email, loginEmail: email, phone: '', provider, name, picture };
  };
}

/**
 * Registers request decoration + reusable guard chains:
 *   guards.authed   - valid token; req.member is the DB row (or null if they never requested access)
 *   guards.approved - authed AND an approved member (or the owner)
 *   guards.owner    - authed AND the platform owner
 * The owner is defined by the OWNER_EMAILS env var (never by client data) and is auto-provisioned.
 */
export function registerAuth(app, { config, pool, verifyToken, hub }) {
  app.decorateRequest('user', null);
  app.decorateRequest('member', null);

  // Every request needs the caller's membership row. Cache it briefly; it is dropped immediately when
  // an admin decision / profile change is announced (Postgres NOTIFY reaches every API instance), and
  // wholesale after a listener reconnect. The TTL is only a safety net.
  const memberCache = new TtlCache({ ttlMs: config.memberCacheMs, max: 5000 });
  app.decorate('invalidateMember', (email) => memberCache.delete(email));
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

  async function loadMember(req) {
    req.member = await memberCache.getOrLoad(req.user.email, () => resolveMember(req.user));
  }

  // Hooks must be async (or call done): a sync hook that returns normally would hang the request.
  async function requireApproved(req) {
    if (!req.member) throw forbidden('Request access first', 'no_account');
    if (req.member.status !== 'approved') {
      throw forbidden(`Your access request is ${req.member.status}`, `not_approved_${req.member.status}`);
    }
  }

  async function requireOwner(req) {
    if (req.member?.role !== 'owner') throw forbidden('Owner only', 'owner_only');
  }

  const guards = {
    authed: [authenticate, loadMember],
    approved: [authenticate, loadMember, requireApproved],
    owner: [authenticate, loadMember, requireOwner],
  };
  app.decorate('guards', guards);
  return guards;
}
