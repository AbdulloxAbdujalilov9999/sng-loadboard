// Telegram answers 429 "retry after N seconds" when a chat is flooded: wait exactly that long and try again.
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry(fn, { sleep = defaultSleep, attempts = 8 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await fn(); } catch (err) {
      if (err?.response?.error_code !== 429 || attempt >= attempts) throw err;
      await sleep(Math.min(Number(err.response.parameters?.retry_after ?? 3), 60) * 1000 + 300);
    }
  }
}
