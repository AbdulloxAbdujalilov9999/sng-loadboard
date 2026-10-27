// The push half of the Updates feature (bot.js's sendUpdates is the on-demand half, same
// t('updates_text') string): sends current load/truck counts to every signed-up Telegram user at
// 08:00/12:00/16:00/20:00 Tashkent time - no overnight pings. The server's clock runs on UTC, so the
// slots are worked out in UTC+5 (Uzbekistan has no daylight saving), not in server-local hours.
// Nothing is sent while the board is empty: "0 loads, 0 trucks" four times a day only tells people
// the board is dead. Only the bot process with
// BOT_SEND_UPDATES_DIGEST set runs this (sngonebot - see bot/src/config.js), same one-process-does-it
// pattern as saved-search alerts (broadcaster.js). No cron dependency: setTimeout aligned to the next
// slot, same shape as server/src/lib/expiry.js's sweeper.
import { t } from './i18n.js';

const SLOTS = [8, 12, 16, 20]; // hours, Tashkent time
const TZ_OFFSET_H = 5; // Asia/Tashkent, UTC+5 all year

export function msUntilNextSlot(now = new Date()) {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(0);
  const localHour = (d) => (d.getUTCHours() + TZ_OFFSET_H) % 24;
  while (!SLOTS.includes(localHour(next)) || next <= now) next.setTime(next.getTime() + 3600_000);
  return next.getTime() - now.getTime();
}

async function sendWithRetry(bot, chatId, text) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await bot.telegram.sendMessage(chatId, text); } catch (err) {
      if (err?.response?.error_code !== 429 || attempt >= 3) throw err;
      const waitS = Number(err.response.parameters?.retry_after) || 3;
      await new Promise((r) => setTimeout(r, waitS * 1000));
    }
  }
}

export function startUpdatesDigest({ bot, apiClient, tokens, store, config, log = console }) {
  let timer = null;
  let stopped = false;

  async function sendOnce() {
    const userIds = await store.listAllTelegramUserIds();
    if (!userIds.length) return;
    let stats;
    try {
      // Global counts, not personal - any one linked member's token can read them.
      const idToken = await tokens.getIdToken(userIds[0]);
      stats = await apiClient.getStats(idToken);
    } catch (err) {
      log.warn?.(`updates digest: could not fetch stats: ${err.message}`);
      return;
    }
    if (!stats.loads && !stats.trucks) return;
    for (const id of userIds) {
      const lang = (await store.getLanguage?.(id)) ?? config.broadcastLang;
      const text = t(lang, 'updates_text', { loads: stats.loads, trucks: stats.trucks });
      try { await sendWithRetry(bot, id, text); } catch (err) {
        log.warn?.(`updates digest to ${id} failed: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, config.broadcastSpacingMs ?? 60));
    }
  }

  function scheduleNext() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await sendOnce().catch((err) => log.warn?.(`updates digest failed: ${err.message}`));
      scheduleNext();
    }, msUntilNextSlot());
    timer.unref?.();
  }

  return {
    start() { scheduleNext(); },
    stop() { stopped = true; clearTimeout(timer); },
    _sendOnce: sendOnce, // exposed for tests
  };
}
