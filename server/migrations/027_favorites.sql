-- A member's saved individual load/truck posts ("Saved" tab) - distinct from saved_searches, which
-- saves a *filter*, not a *post*. No FK to loads/trucks: posts are soft-deleted (status = 'closed')
-- and later purged, and a favorite on a since-removed post should just stop showing up, not cascade
-- or dangle - the route filters by joining against status = 'active' at read time.
CREATE TABLE favorites (
    id          bigserial PRIMARY KEY,
    member_id   bigint      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    entity_type text        NOT NULL CHECK (entity_type IN ('load', 'truck')),
    entity_id   bigint      NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (member_id, entity_type, entity_id)
);
CREATE INDEX favorites_member_idx ON favorites (member_id, entity_type, id DESC);
