// Verifies the `initData` string a Telegram Mini App sends on launch (see
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
// Telegram signs it with an HMAC-SHA256 derived from the bot token, so a valid signature proves both
// who the Telegram user is and that the request came from this bot's Mini App (not a forged page).
import crypto from 'node:crypto';

const MAX_AGE_SEC = 24 * 3600; // initData is reissued every time the Mini App opens; a day is generous

/** Returns the verified Telegram user, or null if the signature, freshness or shape is wrong. */
export function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (computed.length !== given.length || !crypto.timingSafeEqual(computed, given)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SEC) return null;

  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { return null; }
  if (!user || typeof user.id !== 'number' || !Number.isFinite(user.id)) return null;

  return {
    id: user.id,
    firstName: typeof user.first_name === 'string' ? user.first_name : '',
    lastName: typeof user.last_name === 'string' ? user.last_name : '',
    username: typeof user.username === 'string' ? user.username : '',
  };
}
