import { loadBotConfig } from './config.js';
import { createBotPool } from './db.js';
import { makeCrypto } from './crypto.js';
import { makeFirebaseAuth } from './firebase.js';
import { makeApiClient } from './apiClient.js';
import { makeStore } from './store.js';
import { makeTokenManager } from './tokens.js';
import { makeBot } from './bot.js';

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

  await bot.launch();
  console.log('sng-one AI paste-import bot running');

  const shutdown = async (signal) => {
    console.log(`${signal}: shutting down`);
    bot.stop(signal);
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
