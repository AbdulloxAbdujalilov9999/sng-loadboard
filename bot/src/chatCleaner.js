// "Clear from chat": after publishing, one tap removes the review messages, the copies of the posted loads and the pasted posts from the
// CHAT - and only from the chat. The loads themselves are untouched: they stay on the board, in every group and in «My loads».
import { randomUUID } from 'node:crypto';
import { withRetry } from './retry.js';
import { t } from './i18n.js';

const KEEP_MS = 48 * 3_600_000; // Telegram will not delete a message older than 48 hours anyway

export function makeChatCleaner({ store, log = console, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gapMs = 60 }) {
  const jobs = new Map();    // token -> { userId, chatId, msgIds: Set<number>, loadIds: number[], at }
  const hidden = new Map();  // loadId -> time: the poster's own-chat copy of this load must not be sent (cleared before it arrived)

  function prune() {
    const now = Date.now();
    for (const [k, j] of jobs) if (now - j.at > KEEP_MS) jobs.delete(k);
    for (const [k, at] of hidden) if (now - at > 3_600_000) hidden.delete(k);
  }

  /** Remember what to clear for this person; returns the token the button carries. */
  function register({ userId, chatId, msgIds = [], loadIds = [] }) {
    prune();
    const token = randomUUID().slice(0, 8);
    jobs.set(token, { userId, chatId, msgIds: new Set(msgIds.filter(Boolean)), loadIds: [...new Set(loadIds)], at: Date.now() });
    return token;
  }

  const isHidden = (loadId) => hidden.has(loadId);

  async function clear(ctx, token) {
    await ctx.answerCbQuery().catch(() => {});
    const job = jobs.get(token);
    const own = ctx.callbackQuery?.message?.message_id; // the message carrying the button stays, as the confirmation
    if (!job || job.userId !== ctx.from.id) { await ctx.editMessageText(t(ctx.lang, 'chat_clear_gone')).catch(() => {}); return; }
    jobs.delete(token); // the first tap wins
    await ctx.editMessageText(t(ctx.lang, 'chat_clear_working')).catch(() => {});
    for (const id of job.loadIds) hidden.set(id, Date.now());

    const ids = new Set(job.msgIds);
    for (const loadId of job.loadIds) {
      // the copy of the load the bot sent to this chat (tracked so a deleted load can pull it back out)
      const rows = await store.listSentMessages(loadId).catch(() => []);
      for (const r of rows) if (Number(r.chat_id) === Number(job.chatId)) ids.add(Number(r.message_id));
    }
    ids.delete(own);
    for (const id of ids) {
      await withRetry(() => ctx.telegram.deleteMessage(job.chatId, id), { sleep }).catch(() => {}); // already gone / too old: nothing to do
      if (gapMs > 0) await sleep(gapMs);
    }
    for (const loadId of job.loadIds) await store.deleteSentMessages(loadId).catch((err) => log.warn?.(`forgetting messages of load ${loadId} failed: ${err.message}`));
    await ctx.editMessageText(t(ctx.lang, 'chat_cleared')).catch(() => {});
  }

  return { register, clear, isHidden };
}
