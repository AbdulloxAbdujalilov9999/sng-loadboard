-- Open sign-up: people are members as soon as they sign up (no waiting for an owner's approval).
-- The owner is told about new members and can still block or remove anyone ('rejected' = blocked).
ALTER TABLE members ALTER COLUMN status SET DEFAULT 'approved';
UPDATE members SET status = 'approved', reviewed_at = COALESCE(reviewed_at, now()) WHERE status = 'pending';

-- Phone + 4-digit PIN sign-in (used by the web app and by the Telegram bot). Only a salted scrypt hash is
-- stored. After 5 wrong PINs the account refuses PIN sign-in for 15 minutes (the SMS code still works).
ALTER TABLE members
    ADD COLUMN pin_hash         text,
    ADD COLUMN pin_changed_at   timestamptz,
    ADD COLUMN pin_fails        integer     NOT NULL DEFAULT 0,
    ADD COLUMN pin_locked_until timestamptz;
