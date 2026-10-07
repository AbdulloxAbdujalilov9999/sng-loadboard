import { HttpError } from './errors.js';

/**
 * Per-MEMBER request budget, applied after sign-in (so it knows who is calling).
 * The per-IP limit cannot do this job alone: the Telegram bot makes every member's requests from one
 * server address, so an IP-based "40 posts a minute" would be shared by ALL of its users. This one
 * counts per member however they reach the API (browser, bot, script). It is per API instance, which is
 * plenty for an anti-spam brake; the hard quotas (active loads, posts per hour) live in the database.
 */
export function createMemberLimiter({ max, windowMs = 60_000 }) {
  const hits = new Map(); // member id -> recent request timestamps
  let sweepAt = 0;
  return async function memberLimit(req) {
    const id = req.member?.id;
    if (!id) return; // unauthenticated requests never get this far (the guard rejects them first)
    const now = Date.now();
    const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) throw new HttpError(429, 'rate_limited', 'You are doing that too fast - please wait a moment.');
    recent.push(now);
    hits.set(id, recent);
    if (now > sweepAt) { // keep the map from growing forever
      sweepAt = now + windowMs;
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
  };
}
