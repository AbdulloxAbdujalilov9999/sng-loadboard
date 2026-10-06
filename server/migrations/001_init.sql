-- SNG ONE marketplace: core schema.
-- Design notes
--  * Loads/trucks denormalise the city label + coordinates so list/search queries never join.
--  * Every hot query path is served by a PARTIAL index over status = 'active' rows only, so closed
--    history never slows the live board down.
--  * Pagination is keyset (see server/src/lib/cursor.js); every sort has an index ending in id.
--  * Business rules live in CHECK constraints too, so bad data cannot get in through any code path.

CREATE TABLE members (
    id              bigserial PRIMARY KEY,
    email           text        NOT NULL,
    firebase_uid    text,
    company         text        NOT NULL,
    contact_name    text        NOT NULL DEFAULT '',
    phone           text        NOT NULL DEFAULT '',
    telegram        text        NOT NULL DEFAULT '',
    location        text        NOT NULL DEFAULT '',
    tir_carnet      text        NOT NULL DEFAULT '',
    fleet           text        NOT NULL DEFAULT '',
    routes          text        NOT NULL DEFAULT '',
    status          text        NOT NULL DEFAULT 'pending',
    role            text        NOT NULL DEFAULT 'member',
    requested_at    timestamptz NOT NULL DEFAULT now(),
    reviewed_at     timestamptz,
    reviewed_by     bigint REFERENCES members(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT members_email_lower   CHECK (email = lower(email) AND position('@' IN email) > 1),
    CONSTRAINT members_email_len     CHECK (char_length(email) <= 254),
    CONSTRAINT members_status_valid  CHECK (status IN ('pending', 'approved', 'rejected')),
    CONSTRAINT members_role_valid    CHECK (role IN ('member', 'owner')),
    CONSTRAINT members_company_len    CHECK (char_length(company) BETWEEN 1 AND 120),
    CONSTRAINT members_text_len      CHECK (
        char_length(contact_name) <= 120 AND char_length(phone) <= 40 AND char_length(telegram) <= 40 AND
        char_length(location) <= 120 AND char_length(tir_carnet) <= 60 AND
        char_length(fleet) <= 200 AND char_length(routes) <= 300)
);
CREATE UNIQUE INDEX members_email_key ON members (email);
CREATE UNIQUE INDEX members_uid_key ON members (firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX members_status_idx ON members (status, requested_at DESC);
CREATE INDEX members_directory_idx ON members (company, id) WHERE status = 'approved' AND role = 'member';

CREATE TABLE cities (
    id          serial PRIMARY KEY,
    name        text             NOT NULL,
    name_ru     text             NOT NULL,
    country     char(2)          NOT NULL,
    lat         double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng         double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
    label       text             NOT NULL,           -- "Tashkent, UZ"
    search_key  text             NOT NULL,           -- lower(name) || ' ' || lower(name_ru)
    UNIQUE (name, country)
);
CREATE UNIQUE INDEX cities_label_key ON cities (label);

CREATE TABLE loads (
    id              bigserial PRIMARY KEY,
    owner_id        bigint           NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    status          text             NOT NULL DEFAULT 'active',
    closed_at       timestamptz,

    origin_city_id  integer          NOT NULL REFERENCES cities(id),
    origin_city     text             NOT NULL,
    origin_lat      double precision NOT NULL,
    origin_lng      double precision NOT NULL,
    dest_city_id    integer          NOT NULL REFERENCES cities(id),
    dest_city       text             NOT NULL,
    dest_lat        double precision NOT NULL,
    dest_lng        double precision NOT NULL,

    equip           text             NOT NULL,
    fp              text             NOT NULL,
    weight_t        numeric(6,2)     NOT NULL,
    volume_m3       integer,
    pickup_date     date             NOT NULL,
    delivery_date   date,
    distance_km     integer          NOT NULL,
    rate_usd        numeric(12,2)    NOT NULL,
    commodity       text             NOT NULL,

    company_name    text             NOT NULL,
    contact_name    text             NOT NULL,
    contact_phone   text             NOT NULL,
    contact_email   text             NOT NULL,
    contact_tg      text             NOT NULL,

    created_at      timestamptz      NOT NULL DEFAULT now(),
    updated_at      timestamptz      NOT NULL DEFAULT now(),

    CONSTRAINT loads_status_valid  CHECK (status IN ('active', 'closed')),
    CONSTRAINT loads_equip_valid   CHECK (equip IN ('T', 'R', 'F', 'V', 'AC')),
    CONSTRAINT loads_fp_valid      CHECK (fp IN ('Full', 'Partial')),
    CONSTRAINT loads_weight_range  CHECK (weight_t > 0 AND weight_t <= 100),
    CONSTRAINT loads_volume_range  CHECK (volume_m3 IS NULL OR (volume_m3 > 0 AND volume_m3 <= 200)),
    CONSTRAINT loads_distance_rng  CHECK (distance_km > 0 AND distance_km <= 25000),
    CONSTRAINT loads_rate_range    CHECK (rate_usd >= 0 AND rate_usd <= 10000000),
    CONSTRAINT loads_dates_order   CHECK (delivery_date IS NULL OR delivery_date >= pickup_date),
    CONSTRAINT loads_diff_cities   CHECK (origin_city_id <> dest_city_id),
    CONSTRAINT loads_commodity_len CHECK (char_length(commodity) BETWEEN 1 AND 200),
    CONSTRAINT loads_contact_len   CHECK (
        char_length(contact_name) <= 120 AND char_length(contact_phone) <= 40 AND
        char_length(contact_email) <= 254 AND char_length(contact_tg) <= 40 AND char_length(company_name) <= 120)
);

-- Default feed (newest first) and every filter/sort combination the UI offers.
-- All partial on status = 'active'; all end in id so keyset pagination is a pure index range scan.
CREATE INDEX loads_feed_idx        ON loads (id DESC)                  WHERE status = 'active';
CREATE INDEX loads_equip_feed_idx  ON loads (equip, id DESC)           WHERE status = 'active';
CREATE INDEX loads_pickup_idx      ON loads (pickup_date, id)          WHERE status = 'active';
CREATE INDEX loads_rate_idx        ON loads (rate_usd, id)             WHERE status = 'active';
CREATE INDEX loads_distance_idx    ON loads (distance_km, id)          WHERE status = 'active';
CREATE INDEX loads_weight_idx      ON loads (weight_t, id)             WHERE status = 'active';
CREATE INDEX loads_origin_name_idx ON loads (origin_city, id)          WHERE status = 'active';
CREATE INDEX loads_dest_name_idx   ON loads (dest_city, id)            WHERE status = 'active';
-- Radius ("deadhead") search: bounding-box range scan, exact haversine applied on the survivors.
CREATE INDEX loads_origin_geo_idx  ON loads (origin_lat, origin_lng)   WHERE status = 'active';
CREATE INDEX loads_dest_geo_idx    ON loads (dest_lat, dest_lng)       WHERE status = 'active';
CREATE INDEX loads_owner_idx       ON loads (owner_id, id DESC)        WHERE status = 'active';

CREATE TABLE trucks (
    id              bigserial PRIMARY KEY,
    owner_id        bigint           NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    status          text             NOT NULL DEFAULT 'active',
    closed_at       timestamptz,

    loc_city_id     integer          NOT NULL REFERENCES cities(id),
    loc_city        text             NOT NULL,
    loc_lat         double precision NOT NULL,
    loc_lng         double precision NOT NULL,
    dest_pref       text             NOT NULL DEFAULT 'Anywhere',

    equip           text             NOT NULL,
    capacity_t      numeric(6,2)     NOT NULL,
    volume_m3       integer,
    available_from  date             NOT NULL,
    available_to    date,
    min_rate_usd    numeric(12,2),
    has_tir         boolean          NOT NULL DEFAULT false,
    has_adr         boolean          NOT NULL DEFAULT false,
    has_gps         boolean          NOT NULL DEFAULT false,
    side_loading    boolean          NOT NULL DEFAULT false,

    company_name    text             NOT NULL,
    contact_phone   text             NOT NULL,
    contact_tg      text             NOT NULL,

    created_at      timestamptz      NOT NULL DEFAULT now(),
    updated_at      timestamptz      NOT NULL DEFAULT now(),

    CONSTRAINT trucks_status_valid CHECK (status IN ('active', 'closed')),
    CONSTRAINT trucks_equip_valid  CHECK (equip IN ('T', 'R', 'F', 'V', 'AC')),
    CONSTRAINT trucks_cap_range    CHECK (capacity_t > 0 AND capacity_t <= 100),
    CONSTRAINT trucks_vol_range    CHECK (volume_m3 IS NULL OR (volume_m3 > 0 AND volume_m3 <= 200)),
    CONSTRAINT trucks_rate_range   CHECK (min_rate_usd IS NULL OR (min_rate_usd >= 0 AND min_rate_usd <= 10000000)),
    CONSTRAINT trucks_dates_order  CHECK (available_to IS NULL OR available_to >= available_from),
    CONSTRAINT trucks_dest_len     CHECK (char_length(dest_pref) BETWEEN 1 AND 120)
);

-- A truck with no explicit end date stays visible for 30 days, then drops off the board by itself.
-- (The expression is immutable so it can be indexed.)
ALTER TABLE trucks ADD COLUMN expires_on date GENERATED ALWAYS AS (COALESCE(available_to, available_from + 30)) STORED;

CREATE INDEX trucks_feed_idx       ON trucks (id DESC)                 WHERE status = 'active';
CREATE INDEX trucks_equip_feed_idx ON trucks (equip, id DESC)          WHERE status = 'active';
CREATE INDEX trucks_avail_idx      ON trucks (available_from, id)      WHERE status = 'active';
CREATE INDEX trucks_expiry_idx     ON trucks (expires_on)              WHERE status = 'active';
CREATE INDEX trucks_loc_geo_idx    ON trucks (loc_lat, loc_lng)        WHERE status = 'active';
CREATE INDEX trucks_owner_idx      ON trucks (owner_id, id DESC)       WHERE status = 'active';

-- Display-currency rates (units of currency per 1 USD). Seeded with placeholders; the owner updates
-- them through PUT /api/admin/fx. All money is STORED in USD; this only affects what users see.
CREATE TABLE fx_rates (
    code        char(3) PRIMARY KEY,
    symbol      text           NOT NULL,
    per_usd     numeric(18,6)  NOT NULL CHECK (per_usd > 0),
    updated_at  timestamptz    NOT NULL DEFAULT now()
);
INSERT INTO fx_rates (code, symbol, per_usd) VALUES
    ('USD', '$',    1),
    ('RUB', '₽',    92.5),
    ('KZT', '₸',    475),
    ('UZS', 'so''m', 12600),
    ('KGS', 'som',  89.5),
    ('TJS', 'ЅМ',   10.9),
    ('BYN', 'Br',   3.3),
    ('AZN', '₼',    1.7),
    ('GEL', '₾',    2.7),
    ('AMD', '֏',    405);
