// Sign-in for the Telegram Mini App: trades Telegram's signed initData for a session token, with no
// password step - Telegram already proved who is asking. A first-time Telegram user gets a session for
// a not-yet-created account (same shape as a brand-new Google sign-in); the usual /api/me/access-request
// flow then creates their member row and binds it to this Telegram id for next time.
import { HttpError } from '../lib/errors.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { telegramIdentity } from '../lib/identity.js';
import { signTelegramSession } from '../lib/telegramSession.js';

export default async function telegramAuthRoutes(app, { pool, config }) {
  const enabled = Boolean(config.telegramBotToken && config.authSecret);

  app.post('/api/auth/telegram', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req) => {
    if (!enabled) throw new HttpError(404, 'telegram_auth_disabled', 'Telegram sign-in is not enabled on this server');
    const initData = typeof req.body?.initData === 'string' ? req.body.initData : '';
    const user = verifyTelegramInitData(initData, config.telegramBotToken);
    if (!user) throw new HttpError(401, 'bad_telegram_auth', 'Could not verify Telegram sign-in');

    const { rows: [existing] } = await pool.query('SELECT email FROM members WHERE telegram_user_id = $1', [user.id]);
    const identity = existing ? existing.email : telegramIdentity(user.id);
    return signTelegramSession({ secret: config.authSecret, identity, telegramUserId: user.id });
  });
}
