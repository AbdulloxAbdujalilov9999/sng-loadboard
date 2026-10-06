-- Free-text notes on a load (payment terms, loading readiness, extra destinations ...) and a member's
-- default contact e-mail for new posts (falls back to the Google login e-mail when empty).
ALTER TABLE loads   ADD COLUMN notes         text NOT NULL DEFAULT '';
ALTER TABLE loads   ADD CONSTRAINT loads_notes_len CHECK (char_length(notes) <= 500);
ALTER TABLE members ADD COLUMN contact_email text NOT NULL DEFAULT '';
ALTER TABLE members ADD CONSTRAINT members_contact_email_len CHECK (char_length(contact_email) <= 254);
