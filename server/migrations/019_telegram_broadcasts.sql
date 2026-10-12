-- Which load has been sent to which group/channel by the Telegram bot. The bot keeps its to-do list in memory; this table lets it
-- notice after a restart or a crash that some loads never reached a group, and send them then (bot/src/broadcaster.js).
CREATE TABLE telegram_broadcasts (
    load_id bigint      NOT NULL REFERENCES loads(id) ON DELETE CASCADE,
    chat_id bigint      NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (load_id, chat_id)
);
-- Loads that exist now were already handled by the old code: only loads posted from now on can be "missing".
INSERT INTO telegram_broadcasts (load_id, chat_id)
SELECT l.id, c.chat_id FROM loads l CROSS JOIN telegram_chats c WHERE l.created_at > now() - interval '3 days'
ON CONFLICT DO NOTHING;
