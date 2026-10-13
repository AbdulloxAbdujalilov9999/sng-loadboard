-- "Near me" in the Telegram bot: the position a person shared with the bot (Telegram's own "share location" button), kept so the next
-- search does not have to ask again. It is theirs to delete any time (the bot has a button for it) and is used only to search around them.
ALTER TABLE telegram_users
    ADD COLUMN geo_lat   double precision,
    ADD COLUMN geo_lng   double precision,
    ADD COLUMN geo_at    timestamptz,
    ADD COLUMN geo_miles integer NOT NULL DEFAULT 100;
ALTER TABLE telegram_users ADD CONSTRAINT telegram_users_geo_valid
    CHECK ((geo_lat IS NULL) = (geo_lng IS NULL) AND geo_miles BETWEEN 5 AND 500
           AND (geo_lat IS NULL OR (geo_lat BETWEEN -90 AND 90 AND geo_lng BETWEEN -180 AND 180)));
