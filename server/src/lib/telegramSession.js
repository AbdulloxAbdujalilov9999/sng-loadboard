// Sessions issued after a verified Telegram Mini App sign-in (see lib/telegramAuth.js). Same shape as
// the phone+PIN sessions in lib/pin.js (an HS256 JWT this server signs and later re-verifies) but a
// separate audience/key, because the two have different trust models: a PIN session is only valid
// while the member's pin_hash matches what signed it (see auth.js), while a Telegram session is valid
// for as long as the token has not expired - there is no password of its own to invalidate against.
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'sng-one';
const AUDIENCE = 'sng-one-tg';
const TTL_SEC = 30 * 24 * 3600; // 30 days, same as a web PIN session

const keyOf = (secret) => crypto.createHash('sha256').update(`sng-tg-session\n${secret}`).digest();

export async function signTelegramSession({ secret, identity, telegramUserId }) {
  const token = await new SignJWT({ tg: String(telegramUserId) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(identity).setIssuer(ISSUER).setAudience(AUDIENCE)
    .setIssuedAt().setExpirationTime(`${TTL_SEC}s`)
    .sign(keyOf(secret));
  return { token, expiresAt: new Date(Date.now() + TTL_SEC * 1000).toISOString() };
}

export async function verifyTelegramSession({ secret, token }) {
  const { payload } = await jwtVerify(token, keyOf(secret), { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'], clockTolerance: 30 });
  if (!payload.sub || typeof payload.tg !== 'string') throw new Error('bad session token');
  return { identity: payload.sub, telegramUserId: payload.tg, iat: payload.iat, exp: payload.exp };
}
