// Phone + 4-digit PIN sign-in: PIN hashing, PIN rules, and the session tokens the server itself issues for it.
//
// A 4-digit PIN has only 10,000 possibilities, so the safety does not come from the PIN alone:
//   * it is stored only as a salted scrypt hash, mixed with a server secret (AUTH_SECRET),
//   * 5 wrong tries lock PIN sign-in for that phone number for 15 minutes (see routes/pin.js),
//   * the sign-in endpoint is rate-limited per IP,
//   * obvious PINs (0000, 1234 ...) are refused,
//   * the owner is identified by a verified e-mail and can never sign in with a PIN.
import crypto from 'node:crypto';
import { SignJWT, jwtVerify, decodeProtectedHeader } from 'jose';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scrypt = (input, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(input, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, key) => (err ? reject(err) : resolve(key)));
});

export const PIN_RE = /^\d{4}$/;
const WEAK = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '4321', '0123', '3210', '1212', '2580', '1122', '1010', '2000', '2024', '2025', '2026']);
export const isWeakPin = (pin) => WEAK.has(pin);

const prehash = (secret, identity, pin) => crypto.createHmac('sha256', secret).update(`${identity}\n${pin}`).digest();

export async function hashPin({ secret, identity, pin }) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(prehash(secret, identity, pin), salt);
  return `scrypt1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPin({ secret, identity, pin, stored }) {
  const [tag, saltB64, keyB64] = String(stored ?? '').split('$');
  if (tag !== 'scrypt1' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(prehash(secret, identity, pin), Buffer.from(saltB64, 'base64'));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

/** Takes the same time as a real check, so "no such phone" cannot be told apart from "wrong PIN" by timing. */
export async function burnPinCheck(secret) {
  await scrypt(prehash(secret, 'nobody', '0000'), Buffer.alloc(16));
}

// ---- sessions issued by this server (HS256), accepted next to Firebase's RS256 tokens ----
const ISSUER = 'sng-one';
const AUDIENCE = 'sng-one-pin';
export const WEB_TTL_SEC = 30 * 24 * 3600;
export const BOT_TTL_SEC = 180 * 24 * 3600;

const keyOf = (secret) => crypto.createHash('sha256').update(`sng-pin-session\n${secret}`).digest();

export async function signSession({ secret, identity, phone, purpose = 'web' }) {
  const ttl = purpose === 'bot' ? BOT_TTL_SEC : WEB_TTL_SEC;
  const token = await new SignJWT({ ph: phone, pr: purpose })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(identity).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setIssuedAt().setExpirationTime(`${ttl}s`)
    .sign(keyOf(secret));
  return { token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
}

/** True for tokens this server signed itself (Firebase's are RS256). */
export function isOwnToken(token) {
  try { return decodeProtectedHeader(token).alg === 'HS256'; } catch { return false; }
}

export async function verifySession({ secret, token }) {
  const { payload } = await jwtVerify(token, keyOf(secret), { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], clockTolerance: 30 });
  if (!payload.sub || typeof payload.ph !== 'string') throw new Error('bad session token');
  return { identity: payload.sub, phone: payload.ph, purpose: payload.pr === 'bot' ? 'bot' : 'web', iat: payload.iat, exp: payload.exp };
}
