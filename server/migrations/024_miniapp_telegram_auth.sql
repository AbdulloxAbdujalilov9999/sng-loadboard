-- Telegram Mini App sign-in: a member identified directly by their Telegram user id (see
-- server/src/lib/telegramAuth.js and routes/telegramAuth.js). This is independent of telegram_links
-- (006_telegram.sql), which only links an EXISTING phone+PIN account to the bot - a Mini App member
-- may never have signed in on the website at all.
ALTER TABLE members ADD COLUMN telegram_user_id bigint;
CREATE UNIQUE INDEX members_telegram_user_id_key ON members (telegram_user_id) WHERE telegram_user_id IS NOT NULL;
