-- One account, several ways in: any member may have a verified "sign-in phone" next to their Google / e-mail login.
-- Phone + PIN (and the SMS code) then lead to the SAME member. Phone-only members have it from the start.
ALTER TABLE members ADD COLUMN login_phone text;
UPDATE members SET login_phone = '+' || substring(email from 2 for position('@' in email) - 2)
 WHERE email ~ '^p[0-9]+@phone\.sng$';
CREATE UNIQUE INDEX members_login_phone_key ON members (login_phone) WHERE login_phone IS NOT NULL;
ALTER TABLE members ADD CONSTRAINT members_login_phone_fmt CHECK (login_phone IS NULL OR login_phone ~ '^\+[0-9]{8,15}$');
