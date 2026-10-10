-- Case-insensitive search for Russian (and any non-ASCII) text that does NOT depend on the database's locale.
-- lower()/ILIKE only fold Cyrillic correctly on some Postgres installs (a "C" locale leaves "МОСКВА" != "москва").
-- sng_fold() maps Cyrillic capitals (and ё -> е) explicitly, so the same result comes out everywhere. The web/server
-- side folds the search text the same way (foldText in lib/dto.js), then compares with LIKE.
DO $$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'This database uses encoding %, but SNG ONE needs UTF8 (Russian / Uzbek text). Create the database with ENCODING ''UTF8''.', current_setting('server_encoding');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sng_fold(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT lower(translate(t,
    'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯҚҒҲЎ',
    'абвгдеежзийклмнопрстуфхцчшщъыьэюяқғҳў'))
$$;

DROP INDEX IF EXISTS loads_search_trgm_idx;
ALTER TABLE loads DROP COLUMN search_text;
ALTER TABLE loads ADD COLUMN search_text text GENERATED ALWAYS AS (
    sng_fold(commodity || ' ' || company_name || ' ' || origin_city || ' ' || dest_city)
) STORED;
CREATE INDEX loads_search_trgm_idx ON loads USING gin (search_text gin_trgm_ops) WHERE status = 'active';
