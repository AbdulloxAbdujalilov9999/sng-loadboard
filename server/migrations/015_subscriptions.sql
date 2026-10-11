-- Subscriptions, managed by hand by the owner (no payment provider): a free trial, then paid time that the owner
-- adds after the member pays. Everything is OFF until the owner switches it on (settings.enabled).
CREATE TABLE app_settings (
    key        text PRIMARY KEY,
    value      jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE members ADD COLUMN trial_ends_at timestamptz;   -- NULL = the trial starts when subscriptions are switched on
ALTER TABLE members ADD COLUMN paid_until    timestamptz;
