-- The AI paste-import bot's own group/channel broadcast list (pastebot/). Deliberately a separate
-- table from telegram_chats (006_telegram.sql): that table is the BROADCAST bot's membership, a
-- different @BotFather bot/token, so it is only ever a member of the groups the broadcast bot was
-- added to. A chat_id is per-bot - the paste bot being added to a group does not add the broadcast
-- bot to it, and vice versa - so each bot needs its own chat list or it would try to post into
-- groups it never actually joined.

CREATE TABLE pastebot_chats (
    id          bigserial PRIMARY KEY,
    chat_id     bigint      NOT NULL,
    chat_type   text        NOT NULL,
    title       text        NOT NULL DEFAULT '',
    status      text        NOT NULL DEFAULT 'active',
    added_by    bigint,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pastebot_chats_status_valid CHECK (status IN ('active', 'removed')),
    CONSTRAINT pastebot_chats_type_valid   CHECK (chat_type IN ('group', 'supergroup', 'channel')),
    CONSTRAINT pastebot_chats_title_len    CHECK (char_length(title) <= 255)
);
CREATE UNIQUE INDEX pastebot_chats_chatid_key ON pastebot_chats (chat_id);
CREATE INDEX pastebot_chats_active_idx ON pastebot_chats (id) WHERE status = 'active';
