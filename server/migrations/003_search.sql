-- Fast free-text search. A trigram GIN index makes ILIKE '%text%' an index lookup instead of a scan
-- over every active load (measured: ~80 req/s -> thousands at 50k loads; the gap widens with size).
-- pg_trgm is a "trusted" extension, so it can be created without superuser on managed Postgres.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE loads ADD COLUMN search_text text GENERATED ALWAYS AS (
    lower(commodity || ' ' || company_name || ' ' || origin_city || ' ' || dest_city)
) STORED;

CREATE INDEX loads_search_trgm_idx ON loads USING gin (search_text gin_trgm_ops) WHERE status = 'active';
