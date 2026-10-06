-- Anti-spam quota checks ("posts in the last hour") look at a member's recent rows regardless of status,
-- which the partial owner indexes cannot serve. Without this every POST scanned the whole table.
CREATE INDEX loads_owner_recent_idx  ON loads  (owner_id, created_at DESC);
CREATE INDEX trucks_owner_recent_idx ON trucks (owner_id, created_at DESC);
