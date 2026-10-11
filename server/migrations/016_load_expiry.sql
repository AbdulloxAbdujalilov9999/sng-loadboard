-- Loads expire on their own (default: 24 hours after they were posted) so the board never fills up with stale freight.
-- The sweeper looks for active loads older than the limit; this keeps that look-up cheap.
CREATE INDEX loads_active_created_idx ON loads (created_at) WHERE status = 'active';
-- Closed (removed / expired) posts are kept for a while, then purged; these keep that clean-up cheap.
CREATE INDEX loads_closed_idx  ON loads  (closed_at) WHERE status = 'closed';
CREATE INDEX trucks_closed_idx ON trucks (closed_at) WHERE status = 'closed';
