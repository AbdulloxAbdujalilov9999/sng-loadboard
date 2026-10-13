// Everything the bot persists for itself: which Telegram user is which member (telegram_links),
// and which chats it should broadcast new loads to (telegram_chats). Separate from the API's own
// tables/queries - the bot never writes to `members` or `loads` directly, only reads loads for
// broadcasting (see broadcaster.js) and always posts through the real API (see apiClient.js) so
// every quota/validation rule still applies no matter which door a load came in through.

export function makeStore(pool, crypto) {
  // Re-linking can happen from either side (same Telegram account picks a different e-mail, or the
  // same member re-links from a new Telegram account after losing the old one) - a single INSERT
  // can only target one unique constraint, so clear both possible prior rows first, in one transaction.
  async function saveLink({ memberId, telegramUserId, telegramUsername, refreshToken }) {
    const enc = crypto.encrypt(refreshToken);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM telegram_links WHERE member_id = $1 OR telegram_user_id = $2', [memberId, telegramUserId]);
      await client.query(
        `INSERT INTO telegram_links (member_id, telegram_user_id, telegram_username, refresh_token_enc)
         VALUES ($1, $2, $3, $4)`,
        [memberId, telegramUserId, telegramUsername, enc],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function getLinkByTelegramUserId(telegramUserId) {
    const { rows: [row] } = await pool.query(
      `SELECT l.*, m.email, m.status AS member_status, m.role AS member_role,
              m.company, m.contact_name, m.phone, m.telegram, m.contact_email
         FROM telegram_links l JOIN members m ON m.id = l.member_id
        WHERE l.telegram_user_id = $1`,
      [telegramUserId],
    );
    if (!row) return null;
    return { ...row, refreshToken: crypto.decrypt(row.refresh_token_enc) };
  }

  async function updateRefreshToken(telegramUserId, refreshToken) {
    await pool.query(
      'UPDATE telegram_links SET refresh_token_enc = $2, updated_at = now() WHERE telegram_user_id = $1',
      [telegramUserId, crypto.encrypt(refreshToken)],
    );
  }

  async function removeLink(telegramUserId) {
    const { rowCount } = await pool.query('DELETE FROM telegram_links WHERE telegram_user_id = $1', [telegramUserId]);
    return rowCount > 0;
  }

  async function upsertChat({ chatId, chatType, title, addedBy }) {
    await pool.query(
      `INSERT INTO telegram_chats (chat_id, chat_type, title, added_by, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (chat_id) DO UPDATE SET chat_type = $2, title = $3, status = 'active', updated_at = now()`,
      [chatId, chatType, title.slice(0, 255), addedBy ?? null],
    );
  }

  async function markChatRemoved(chatId) {
    await pool.query(`UPDATE telegram_chats SET status = 'removed', updated_at = now() WHERE chat_id = $1`, [chatId]);
  }

  async function listActiveChatIds() {
    const { rows } = await pool.query(`SELECT chat_id FROM telegram_chats WHERE status = 'active' ORDER BY id`);
    return rows.map((r) => r.chat_id);
  }

  // Telegram accounts linked to a platform owner: they get a message when someone new signs up.
  async function listOwnerTelegramIds() {
    const { rows } = await pool.query(
      `SELECT l.telegram_user_id FROM telegram_links l JOIN members m ON m.id = l.member_id WHERE m.role = 'owner' AND m.status = 'approved'`);
    return rows.map((r) => r.telegram_user_id);
  }

  async function countActiveChats() {
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM telegram_chats WHERE status = 'active'`);
    return n;
  }

  // The member's own DM chat, if they've ever linked - broadcaster.js sends them a copy of their
  // own load too, the same message every group gets.
  async function getTelegramUserIdByMemberId(memberId) {
    const { rows: [row] } = await pool.query('SELECT telegram_user_id FROM telegram_links WHERE member_id = $1', [memberId]);
    return row?.telegram_user_id ?? null;
  }

  // Remembers which (chat, message) pair carried a given load, so closing/removing it can delete
  // those messages too - see broadcaster.js's 'delete' event handling.
  async function saveSentMessage({ loadId, chatId, messageId }) {
    await pool.query(
      `INSERT INTO telegram_load_messages (load_id, chat_id, message_id) VALUES ($1, $2, $3)
       ON CONFLICT (load_id, chat_id) DO UPDATE SET message_id = $3`,
      [loadId, chatId, messageId],
    );
  }

  // Which loads reached which group (see migration 019): lets the broadcaster send the missing ones after a restart or a failure.
  async function markBroadcasts(chatId, loadIds) {
    if (!loadIds.length) return;
    await pool.query(
      `INSERT INTO telegram_broadcasts (load_id, chat_id) SELECT unnest($2::bigint[]), $1 ON CONFLICT DO NOTHING`, [chatId, loadIds]);
  }

  // Active loads from the last two hours that some active group has not received yet (and that the group could have received:
  // it joined before the load was posted). Loads younger than `minAgeSec` are left alone - the normal path is still sending them.
  async function listUnsentBroadcasts({ minAgeSec = 90, limit = 500 } = {}) {
    const { rows } = await pool.query(
      `SELECT l.id AS load_id, c.chat_id FROM loads l
         JOIN telegram_chats c ON c.status = 'active' AND c.created_at <= l.created_at
        WHERE l.status = 'active' AND l.created_at > now() - interval '2 hours' AND l.created_at < now() - make_interval(secs => $1::int)
          AND NOT EXISTS (SELECT 1 FROM telegram_broadcasts b WHERE b.load_id = l.id AND b.chat_id = c.chat_id)
        ORDER BY l.id LIMIT $2`, [minAgeSec, limit]);
    return rows;
  }

  async function listSentMessages(loadId) {
    const { rows } = await pool.query('SELECT chat_id, message_id FROM telegram_load_messages WHERE load_id = $1', [loadId]);
    return rows;
  }

  async function deleteSentMessages(loadId) {
    await pool.query('DELETE FROM telegram_load_messages WHERE load_id = $1', [loadId]);
  }

  // null means "never set" - the caller falls back to Telegram's own language_code.
  async function getLanguage(telegramUserId) {
    const { rows: [row] } = await pool.query('SELECT language FROM telegram_users WHERE telegram_user_id = $1', [telegramUserId]);
    return row?.language ?? null;
  }

  // The position this person shared with the bot (Telegram's "share location" button) and the radius they like, in miles. Never creates a
  // row with a made-up language: a new row gets the language the person is being spoken to in.
  async function getGeo(telegramUserId) {
    const { rows: [r] } = await pool.query('SELECT geo_lat, geo_lng, geo_at, geo_miles FROM telegram_users WHERE telegram_user_id = $1', [telegramUserId]);
    if (!r) return { lat: null, lng: null, at: null, miles: 100 };
    return { lat: r.geo_lat, lng: r.geo_lng, at: r.geo_at, miles: r.geo_miles };
  }
  async function setGeo(telegramUserId, { lat, lng, language }) {
    await pool.query(
      `INSERT INTO telegram_users (telegram_user_id, language, geo_lat, geo_lng, geo_at) VALUES ($1, $4, $2, $3, now())
       ON CONFLICT (telegram_user_id) DO UPDATE SET geo_lat = $2, geo_lng = $3, geo_at = now(), updated_at = now()`,
      [telegramUserId, lat, lng, language]);
  }
  async function clearGeo(telegramUserId) {
    await pool.query('UPDATE telegram_users SET geo_lat = NULL, geo_lng = NULL, geo_at = NULL, updated_at = now() WHERE telegram_user_id = $1', [telegramUserId]);
  }
  async function setGeoMiles(telegramUserId, miles, language) {
    await pool.query(
      `INSERT INTO telegram_users (telegram_user_id, language, geo_miles) VALUES ($1, $3, $2)
       ON CONFLICT (telegram_user_id) DO UPDATE SET geo_miles = $2, updated_at = now()`, [telegramUserId, miles, language]);
  }

  async function setLanguage(telegramUserId, language) {
    await pool.query(
      `INSERT INTO telegram_users (telegram_user_id, language) VALUES ($1, $2)
       ON CONFLICT (telegram_user_id) DO UPDATE SET language = $2, updated_at = now()`,
      [telegramUserId, language],
    );
  }

  return {
    saveLink, getLinkByTelegramUserId, updateRefreshToken, removeLink, upsertChat, markChatRemoved,
    listActiveChatIds, listOwnerTelegramIds, countActiveChats, getLanguage, setLanguage,
    getTelegramUserIdByMemberId, saveSentMessage, listSentMessages, deleteSentMessages, markBroadcasts, listUnsentBroadcasts, getGeo, setGeo, clearGeo, setGeoMiles,
  };
}
