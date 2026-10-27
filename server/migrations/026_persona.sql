-- The business role a member picked (shipper / driver / broker), shown throughout the UI and asked
-- at sign-up. Separate from `role` (owner/member - an AUTHORIZATION level used all over the API for
-- permission checks) on purpose: persona is just a self-described label and must never be read as a
-- permission. NULL means "not picked yet" (older members, or someone who skipped the question); the
-- UI prompts them once and they can change it any time in Settings (self-service - no admin needed).
ALTER TABLE members ADD COLUMN persona text CHECK (persona IN ('shipper', 'driver', 'broker'));
CREATE INDEX members_persona_idx ON members (persona) WHERE persona IS NOT NULL;
