-- A member's saved load-search filters (Mini App / sng_loadboard_bot): when a newly-posted load
-- matches, lib/savedSearchAlerts.js tells the bot to DM them. filters mirrors loadQuery (minus
-- sort/paging/near-me) - see lib/schemas.js's savedSearchFilters.
CREATE TABLE saved_searches (
    id          bigserial PRIMARY KEY,
    member_id   bigint      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    name        text        NOT NULL DEFAULT '',
    filters     jsonb       NOT NULL,
    active      boolean     NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_searches_member_idx ON saved_searches (member_id);
CREATE INDEX saved_searches_active_idx ON saved_searches (id) WHERE active;
