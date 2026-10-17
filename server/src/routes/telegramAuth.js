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

    // Two separate paths lead to an existing member: signed up straight through the Mini App
    // (members.telegram_user_id, migration 024) or linked the classic way from either bot's /link
    // command (telegram_links, never written to members - see bot/src/store.js's own comment on
    // this same split). Checking only the first left every classic-link member unrecognized here,
    // handing them a brand-new, empty synthetic identity instead of their real account - exactly the
    // "linked twice" bug the shared-account requirement exists to prevent.
    const { rows: [existing] } = await pool.query(
      `SELECT m.email FROM members m WHERE m.telegram_user_id = $1
         OR m.id = (SELECT member_id FROM telegram_links WHERE telegram_user_id = $1) LIMIT 1`,
      [user.id],
    );
    const identity = existing ? existing.email : telegramIdentity(user.id);
    return signTelegramSession({ secret: config.authSecret, identity, telegramUserId: user.id });
  });
}
