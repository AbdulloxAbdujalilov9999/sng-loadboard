-- Search by whole country ("UZ -> KZ"): the country is the last two letters of the stored city label ("Tashkent, UZ"),
-- so it is derived by the database itself and can never drift from the label.
ALTER TABLE loads  ADD COLUMN origin_country text GENERATED ALWAYS AS (right(origin_city, 2)) STORED;
ALTER TABLE loads  ADD COLUMN dest_country   text GENERATED ALWAYS AS (right(dest_city, 2)) STORED;
ALTER TABLE trucks ADD COLUMN loc_country    text GENERATED ALWAYS AS (right(loc_city, 2)) STORED;
CREATE INDEX loads_country_idx  ON loads  (origin_country, dest_country, id DESC) WHERE status = 'active';
CREATE INDEX trucks_country_idx ON trucks (loc_country, id DESC)                  WHERE status = 'active';
