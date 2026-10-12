// Bot-specific environment. Kept separate from server/src/config.js: this is a different process
// with different required secrets (it must never need OWNER_EMAILS, GEMINI_API_KEY, etc. - the
// Gemini key stays on the loadboard API; this bot only ever calls POST /api/ai/parse-loads).
import { LANGS, DEFAULT_LANG } from './i18n.js';

const truthy = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export function loadBotConfig(env = process.env) {
  const apiBaseUrl = (env.API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const cfg = {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    apiBaseUrl,
    // The address a person's browser can actually reach, used to build "view this load" links in the
    // posted-confirmation message. Defaults to apiBaseUrl; set this when the bot talks to the API
    // over an internal address (e.g. Render) but the public site is elsewhere.
    webBaseUrl: (env.PUBLIC_WEB_URL || apiBaseUrl).replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL,
    databaseSsl: truthy(env.DATABASE_SSL, false),
    firebaseApiKey: env.FIREBASE_WEB_API_KEY || '',
    firebaseProjectId: env.FIREBASE_PROJECT_ID || 'sng-pro',
    encryptionKey: env.BOT_ENCRYPTION_KEY || '',
    logLevel: env.LOG_LEVEL || 'info',
    // How many /api/ai/parse-loads calls this process makes per minute at most, independent of how
    // many people paste at once - keeps the bot well under the server's per-member hourly AI budget
    // and Gemini's own rate limits even if several members paste in the same minute.
    aiMaxPerMin: Number(env.AI_PASTE_MAX_PER_MIN || 20),
    // How long a parsed batch stays open for the Post/Cancel buttons before it expires and must be
    // re-pasted - avoids posting drafts built from a stale city/AI response long after the fact.
    pendingTtlMin: Number(env.PASTE_PENDING_TTL_MIN || 15),
    // Default language for brand-new chats before Telegram's own language_code or /language picks one.
    defaultLang: LANGS.includes(env.BOT_DEFAULT_LANG) ? env.BOT_DEFAULT_LANG : DEFAULT_LANG,
  };
  cfg.webUrlIsPublic = !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^./:]+(:\d+)?(\/|$))/i.test(cfg.webBaseUrl);
  if (env.NODE_ENV === 'production' && !cfg.webUrlIsPublic) {
    console.warn(`PUBLIC_WEB_URL is not set to a public address (using ${cfg.webBaseUrl}): "view this load" links will be left out. Set PUBLIC_WEB_URL to your site's https:// address.`);
  }
  const problems = [];
  if (!cfg.botToken) problems.push('TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather and paste its token)');
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required (same database as the sng-loadboard API)');
  if (!cfg.firebaseApiKey) problems.push('FIREBASE_WEB_API_KEY is required (the "apiKey" from sng-loadboard/web/js/config.js - it is public by design)');
  if (!cfg.encryptionKey) problems.push('BOT_ENCRYPTION_KEY is required: 32 random bytes, base64. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  else if (Buffer.from(cfg.encryptionKey, 'base64').length !== 32) problems.push('BOT_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes');
  if (problems.length) throw new Error('Invalid bot configuration:\n - ' + problems.join('\n - '));
  return cfg;
}
