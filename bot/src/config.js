// Bot-specific environment. Kept separate from server/src/config.js: the bot is a different
// process with different required secrets (it must never need OWNER_EMAILS, GEMINI_API_KEY, etc.).
import { LANGS, DEFAULT_LANG } from './i18n.js';

const truthy = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export function loadBotConfig(env = process.env) {
  const apiBaseUrl = (env.API_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
  const cfg = {
    botToken: env.TELEGRAM_BOT_TOKEN || '',
    // A Telegram bot token is "<numeric bot id>:<secret>" - the id half, so telegram_chats can be
    // scoped per bot (see migration 023). Lets two bot processes (e.g. an old token being retired
    // and a new one taking over) run against the same database without each one's broadcaster
    // trying - and failing, and wrongly deregistering - a chat only the OTHER bot is a member of.
    botId: Number((env.TELEGRAM_BOT_TOKEN || '').split(':')[0]) || 0,
    apiBaseUrl,
    // The address a person's browser can actually reach, used to build "view this load" links.
    // Defaults to apiBaseUrl (true for a self-hosted single-domain setup); on a platform where the
    // bot talks to the API over an internal address (e.g. Render), set this to the public URL.
    webBaseUrl: (env.PUBLIC_WEB_URL || apiBaseUrl).replace(/\/+$/, ''),
    // The Mini App's public https:// URL (Telegram refuses anything else), e.g. https://sng-miniapp.onrender.com.
    // Leave blank to run the bot without a Mini App: /app just explains it is not set up yet, and the chat menu
    // button is left alone.
    miniAppUrl: (env.MINIAPP_URL || '').replace(/\/+$/, ''),
    databaseUrl: env.DATABASE_URL,
    databaseSsl: truthy(env.DATABASE_SSL, false),
    firebaseApiKey: env.FIREBASE_WEB_API_KEY || '',
    firebaseProjectId: env.FIREBASE_PROJECT_ID || 'sng-pro',
    encryptionKey: env.BOT_ENCRYPTION_KEY || '',
    logLevel: env.LOG_LEVEL || 'info',
    // Spacing between consecutive Telegram sends while broadcasting one load to many chats
    // (Telegram's own limit is ~30 msg/s across all chats); keep this well under it.
    broadcastSpacingMs: Number(env.BOT_BROADCAST_SPACING_MS || 60),
    // Minimum gap between two messages to the SAME chat: a group/channel takes ~20 a minute, a private chat ~1 a second. Without it a
    // 50-load post would be cut off by Telegram's flood limit part-way through.
    // Off: one message per load everywhere. On: when 3+ loads wait for a group, up to 5 go out as one message (faster, but not what members want).
    broadcastDigest: ['1', 'true', 'yes'].includes(String(env.BOT_BROADCAST_DIGEST ?? '').toLowerCase()),
    // Trucks posted on the website or in the bot go to the groups too, one message each (set BOT_BROADCAST_TRUCKS=0 for loads only).
    broadcastTrucks: !['0', 'false', 'no', 'off'].includes(String(env.BOT_BROADCAST_TRUCKS ?? '').toLowerCase()),
    broadcastGroupGapMs: Number(env.BOT_BROADCAST_GROUP_GAP_MS ?? 3100),
    broadcastOwnerGapMs: Number(env.BOT_BROADCAST_OWNER_GAP_MS ?? 1100),
    // Groups mix members of different languages, so broadcasts use one fixed language for everyone
    // (unlike DMs, which follow each person's own /language choice).
    broadcastLang: LANGS.includes(env.BOT_BROADCAST_LANG) ? env.BOT_BROADCAST_LANG : DEFAULT_LANG,
    // Our own official channel/group, invited in the welcome message, the /postload confirmation,
    // and every broadcast message (see format.js's joinLines) - optional, leave blank to omit.
    // Stored without the leading "@" (stripped if given) so there's never a double "@@".
    joinChannel: (env.BOT_JOIN_CHANNEL || '').replace(/^@/, ''),
    joinGroup: (env.BOT_JOIN_GROUP || '').replace(/^@/, ''),
    // AI paste-import (pasteFlow.js): at most this many /api/ai/parse-loads calls per minute from this process, and how long
    // a parsed batch waits for its Post / Cancel buttons before it must be pasted again.
    aiMaxPerMin: Number(env.AI_PASTE_MAX_PER_MIN || 20),
    pendingTtlMin: Number(env.PASTE_PENDING_TTL_MIN || 60),
    // Pause between the per-load messages of a big review (Telegram allows about one message a second to a chat).
    draftGapMs: Number(env.PASTE_DRAFT_GAP_MS ?? 300),
    // Forwarded messages that arrive within this many ms of each other are read as one paste (one review, one Post button).
    pasteDebounceMs: Number(env.PASTE_DEBOUNCE_MS ?? 2500),
  };
  const problems = [];
  // Links in broadcasts are clicked by people on the internet. An internal/localhost address would be a dead
  // link for everyone, so in production we say so loudly (and the broadcaster omits the link, see format.js).
  cfg.webUrlIsPublic = !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^./:]+(:\d+)?(\/|$))/i.test(cfg.webBaseUrl);
  if (env.NODE_ENV === 'production' && !cfg.webUrlIsPublic) {
    console.warn(`PUBLIC_WEB_URL is not set to a public address (using ${cfg.webBaseUrl}): "view this load" links will be left out. Set PUBLIC_WEB_URL to your site's https:// address.`);
  }
  if (cfg.miniAppUrl && !/^https:\/\//i.test(cfg.miniAppUrl)) {
    console.warn(`MINIAPP_URL (${cfg.miniAppUrl}) is not an https:// address: Telegram will refuse to open it as a Mini App.`);
  }
  if (!cfg.botToken) problems.push('TELEGRAM_BOT_TOKEN is required (create a bot with @BotFather and paste its token)');
  if (!cfg.databaseUrl) problems.push('DATABASE_URL is required (same database as the API)');
  if (!cfg.firebaseApiKey) problems.push('FIREBASE_WEB_API_KEY is required (the "apiKey" from web/js/config.js - it is public by design)');
  if (!cfg.encryptionKey) problems.push('BOT_ENCRYPTION_KEY is required: 32 random bytes, base64. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  else if (Buffer.from(cfg.encryptionKey, 'base64').length !== 32) problems.push('BOT_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes');
  if (problems.length) throw new Error('Invalid bot configuration:\n - ' + problems.join('\n - '));
  return cfg;
}
