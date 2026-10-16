import { loadBotConfig } from './config.js';
import { createBotPool } from './db.js';
import { makeCrypto } from './crypto.js';
import { makeFirebaseAuth } from './firebase.js';
import { makeApiClient } from './apiClient.js';
import { makeStore } from './store.js';
import { makeTokenManager } from './tokens.js';
import { makeBot } from './bot.js';
import { makeBroadcaster } from './broadcaster.js';
import { publishBotProfile } from './profile.js';
import { startUpdatesDigest } from './updatesDigest.js';

async function main() {
  const config = loadBotConfig();
  const pool = createBotPool(config);
  await pool.query('SELECT 1'); // fail fast and loudly if the database is unreachable

  const crypto = makeCrypto(config.encryptionKey);
  const firebaseAuth = makeFirebaseAuth({ apiKey: config.firebaseApiKey });
  const apiClient = makeApiClient({ baseUrl: config.apiBaseUrl });
  const store = makeStore(pool, crypto);
  const tokens = makeTokenManager({ store, firebaseAuth, apiClient });
  const bot = makeBot({ config, firebaseAuth, apiClient, tokens, store });
  const broadcaster = makeBroadcaster({ config, pool, store, bot, suppressOwner: (loadId) => bot.chatCleaner.isHidden(loadId) });

  await broadcaster.start();
  await publishBotProfile(bot.telegram, console, config.variant);
  if (config.miniAppUrl) {
    // Best-effort: the persistent button next to the message box, everyone gets it without asking.
    // /app (bot.js) still works as a fallback if this call fails or the URL changes later.
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'web_app', text: 'App', web_app: { url: config.miniAppUrl } } })
      .catch((err) => console.warn('Could not set the Mini App menu button:', err.message));
  } else {
    // Explicitly reset it: a bot that used to have MINIAPP_URL set (or whose role changed, e.g. the
    // Mini App moving to a different bot identity) would otherwise keep showing a stale "App" button
    // forever - Telegram remembers the last menu button it was told to set, it doesn't expire on its own.
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'default' } })
      .catch((err) => console.warn('Could not reset the menu button:', err.message));
  }
  const chats = await store.countActiveChats(config.botId);
  const updatesDigest = config.sendUpdatesDigest ? startUpdatesDigest({ bot, apiClient, tokens, store, config }) : null;
  updatesDigest?.start();
  // bot.launch() only returns when the bot stops, so the "running" line goes in its start-up callback
  bot.launch(() => console.log(`sng-one telegram bot running (AI paste-import + /paste on) - broadcasting to ${chats} chat(s)`))
    .catch((err) => { console.error('Telegram polling stopped:', err.message); process.exit(1); });

  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    bot.stop(signal);
    updatesDigest?.stop();
    await broadcaster.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start the Telegram bot:', err.message);
  process.exit(1);
});
