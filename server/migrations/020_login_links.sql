-- One-time links that sign a member into the website straight from the Telegram bot (no typing of the phone number and password).
-- Only a hash of the code is stored; a link works once and for 15 minutes.
CREATE TABLE login_links (
    code_hash  text        PRIMARY KEY,
    member_id  bigint      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_links_expires_idx ON login_links (expires_at);
