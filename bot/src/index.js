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
  await publishBotProfile(bot.telegram);
  if (config.miniAppUrl) {
    // Best-effort: the persistent button next to the message box, everyone gets it without asking.
    // /app (bot.js) still works as a fallback if this call fails or the URL changes later.
    await bot.telegram.setChatMenuButton({ menuButton: { type: 'web_app', text: 'App', web_app: { url: config.miniAppUrl } } })
      .catch((err) => console.warn('Could not set the Mini App menu button:', err.message));
  }
  const chats = await store.countActiveChats(config.botId);
  // bot.launch() only returns when the bot stops, so the "running" line goes in its start-up callback
  bot.launch(() => console.log(`sng-one telegram bot running (AI paste-import + /paste on) - broadcasting to ${chats} chat(s)`))
    .catch((err) => { console.error('Telegram polling stopped:', err.message); process.exit(1); });

  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    bot.stop(signal);
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
