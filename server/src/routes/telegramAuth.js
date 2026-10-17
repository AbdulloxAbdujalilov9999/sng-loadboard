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
    // Unlike a PIN or password endpoint, this can't be brute-forced - the only way through is a
    // signature Telegram itself computed, so the limit here isn't guarding a guessable secret, only
    // server load. It also fires on every single Mini App open, not just an explicit "log in", and
    // many real people can share one IP behind mobile-carrier NAT (common in Uzbekistan) - a handful
    // of people opening the app in the same minute was enough to 429 everyone else on that IP, which
    // the Mini App then showed as a flat "sign-in failed", indistinguishable from a real auth bug.
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
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
