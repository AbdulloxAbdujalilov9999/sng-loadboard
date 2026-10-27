-- Growth tools and paid extras (Three Platforms Plan): posting and searching stay free forever; what can be earned or bought
-- is extra reach. Everything here is additive, nothing changes for members who never touch it.
--
-- Referrals: every member gets an invite code; a new member who signs up with it is remembered as referred_by, and when they
-- post their first load the inviter earns TOP credits (lib/growth.js). referral_rewarded makes that happen once per new member.
ALTER TABLE members ADD COLUMN ref_code text NOT NULL DEFAULT substr(md5(random()::text || clock_timestamp()::text), 1, 8);
CREATE UNIQUE INDEX members_ref_code_idx ON members (ref_code);
ALTER TABLE members ADD COLUMN referred_by bigint REFERENCES members(id) ON DELETE SET NULL;
ALTER TABLE members ADD COLUMN referral_rewarded boolean NOT NULL DEFAULT false;
CREATE INDEX members_referred_by_idx ON members (referred_by) WHERE referred_by IS NOT NULL;

-- TOP credits: one credit puts one load at the top of matching searches (and re-sends it to the groups) for BOOST_HOURS.
-- Earned through referrals or added by the owner after a payment (Payme / Click).
ALTER TABLE members ADD COLUMN boost_credits integer NOT NULL DEFAULT 0 CHECK (boost_credits >= 0);
-- Verified badge, set by the owner after checking documents. Copied onto the member's loads (like company_name) so the board's
-- hot search query needs no join.
ALTER TABLE members ADD COLUMN verified_at timestamptz;
ALTER TABLE loads ADD COLUMN owner_verified boolean NOT NULL DEFAULT false;

-- boosted_until: TOP placement. broadcast_at: when the load last went out to the Telegram groups (posting or a free repost);
-- the repost cooldown counts from it, so a plain «Renew» never blocks a repost.
ALTER TABLE loads ADD COLUMN boosted_until timestamptz;
ALTER TABLE loads ADD COLUMN broadcast_at timestamptz NOT NULL DEFAULT now();
UPDATE loads SET broadcast_at = created_at;
CREATE INDEX loads_boosted_idx ON loads (boosted_until) WHERE boosted_until IS NOT NULL AND status = 'active';
