-- Scopes telegram_chats to the specific bot that is actually a member of each chat, so more than
-- one bot process can run against this database at once (e.g. while migrating from an old
-- @BotFather token to a new one) without each one's broadcaster trying - and failing, and wrongly
-- deregistering - a chat only the OTHER bot belongs to. bot_id is the numeric half of a bot token
-- ("<id>:<secret>"), see bot/src/config.js.
--
-- Existing rows were all added while the bot ran under its old token/identity (8742749493), so they
-- are backfilled to that id - a fresh install has no rows yet, so this UPDATE is a no-op for it.
ALTER TABLE telegram_chats ADD COLUMN bot_id bigint;
UPDATE telegram_chats SET bot_id = 8742749493 WHERE bot_id IS NULL;
ALTER TABLE telegram_chats ALTER COLUMN bot_id SET NOT NULL;

DROP INDEX telegram_chats_chatid_key;
CREATE UNIQUE INDEX telegram_chats_chatid_botid_key ON telegram_chats (chat_id, bot_id);

DROP INDEX telegram_chats_active_idx;
CREATE INDEX telegram_chats_active_idx ON telegram_chats (bot_id) WHERE status = 'active';
