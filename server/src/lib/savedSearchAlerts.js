import { createBinder } from './sql.js';
import { loadQuery } from './schemas.js';
import { buildLoadWhere } from './loadFilters.js';
import { publish } from '../events.js';

/**
 * After a load is posted, tell anyone whose saved search matches it. Matching reuses
 * buildLoadWhere - the exact same WHERE a live `GET /api/loads` search would run - so "matches a
 * saved search" and "would show up in a live search with those filters" are always the same thing.
 * Delivery happens elsewhere: this just publishes a 'savedSearchAlert' event on the usual
 * sng_events channel (lib/events.js); only the bot process with BOT_SEND_SEARCH_ALERTS set
 * (the bot process hosting the Mini App, currently @sngonebot - see bot/src/broadcaster.js) actually sends the Telegram message.
 * The poster's own saved searches never fire for their own load (member_id != load.ownerId).
 */
export async function notifyMatchingSearches(app, pool, load) {
  const { rows } = await pool.query(
    `SELECT ss.id, ss.filters, tl.telegram_user_id
       FROM saved_searches ss JOIN telegram_links tl ON tl.member_id = ss.member_id
      WHERE ss.active AND ss.member_id != $1`, [load.ownerId]);
  for (const row of rows) {
    const b = createBinder();
    const q = loadQuery.parse(row.filters);
    const { where } = await buildLoadWhere(app, b, q);
    where.push(`l.id = ${b.P(load.id)}`);
    const { rows: [hit] } = await pool.query(`SELECT 1 FROM loads l WHERE ${where.join(' AND ')} LIMIT 1`, b.params);
    if (hit) {
      await publish(pool, { entity: 'savedSearchAlert', op: 'notify', telegramUserId: Number(row.telegram_user_id), loadId: load.id, savedSearchId: row.id });
    }
  }
}
