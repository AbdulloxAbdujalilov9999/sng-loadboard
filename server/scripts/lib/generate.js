import { roadDistanceKm } from '../../src/lib/geo.js';

/** Small deterministic PRNG so generated datasets (and test failures) are reproducible. */
export function prng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMODITIES = ['Apparel & Cotton Yarn', 'Fresh Fruits (+4C)', 'Reinforcing Steel Rods', 'Machinery Components',
  'Consumer Goods', 'Packaging Materials', 'Dried Apricots & Walnuts', 'Textile Fabric', 'Building Materials',
  'Auto Parts', 'Frozen Meat (-18C)', 'Electronics', 'Chemicals (non-ADR)', 'Furniture', 'Paper & Cardboard', 'Grain (bulk)'];
const EQUIP_BAG = [...Array(55).fill('T'), ...Array(20).fill('R'), ...Array(10).fill('F'), ...Array(10).fill('V'), ...Array(5).fill('AC')];

const isoDay = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function loadCities(pool) {
  const { rows } = await pool.query('SELECT id, label, lat, lng FROM cities ORDER BY id');
  return rows;
}

/** Bulk-insert `count` realistic active loads using UNNEST batches (50k rows in a few seconds). */
export async function insertLoads(pool, { count, owners, seed = 1, batch = 2000, onProgress }) {
  const rnd = prng(seed);
  const cities = await loadCities(pool);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  let done = 0;
  while (done < count) {
    const n = Math.min(batch, count - done);
    const cols = { owner: [], oid: [], ol: [], olat: [], olng: [], did: [], dl: [], dlat: [], dlng: [], equip: [], fp: [], w: [], vol: [],
      pick: [], dist: [], rate: [], com: [], comp: [], cname: [], phone: [], email: [], tg: [] };
    for (let i = 0; i < n; i += 1) {
      const o = pick(cities);
      let d = pick(cities);
      while (d.id === o.id) d = pick(cities);
      const owner = pick(owners);
      const dist = roadDistanceKm(o, d, 1.2);
      cols.owner.push(owner.id); cols.oid.push(o.id); cols.ol.push(o.label); cols.olat.push(o.lat); cols.olng.push(o.lng);
      cols.did.push(d.id); cols.dl.push(d.label); cols.dlat.push(d.lat); cols.dlng.push(d.lng);
      cols.equip.push(pick(EQUIP_BAG)); cols.fp.push(rnd() < 0.85 ? 'Full' : 'Partial');
      cols.w.push(Math.round((1 + rnd() * 25) * 2) / 2); // half-ton steps => many ties
      cols.vol.push(Math.round(20 + rnd() * 80));
      cols.pick.push(isoDay(Math.floor(rnd() * 30)));
      cols.dist.push(dist);
      cols.rate.push(Math.round((dist * (0.5 + rnd() * 0.7)) / 50) * 50); // round to 50 => many ties
      cols.com.push(pick(COMMODITIES)); cols.comp.push(owner.company); cols.cname.push(owner.contact_name || 'Dispatcher');
      cols.phone.push('+998 71 000 00 00'); cols.email.push(owner.email); cols.tg.push('@dispatch_bot');
    }
    await pool.query(
      `INSERT INTO loads (owner_id, origin_city_id, origin_city, origin_lat, origin_lng, dest_city_id, dest_city, dest_lat, dest_lng,
                          equip, fp, weight_t, volume_m3, pickup_date, distance_km, rate_usd, commodity, company_name,
                          contact_name, contact_phone, contact_email, contact_tg)
       SELECT * FROM unnest($1::bigint[], $2::int[], $3::text[], $4::float8[], $5::float8[], $6::int[], $7::text[], $8::float8[], $9::float8[],
                            $10::text[], $11::text[], $12::numeric[], $13::int[], $14::date[], $15::int[], $16::numeric[], $17::text[], $18::text[],
                            $19::text[], $20::text[], $21::text[], $22::text[])`,
      [cols.owner, cols.oid, cols.ol, cols.olat, cols.olng, cols.did, cols.dl, cols.dlat, cols.dlng, cols.equip, cols.fp, cols.w, cols.vol,
        cols.pick, cols.dist, cols.rate, cols.com, cols.comp, cols.cname, cols.phone, cols.email, cols.tg]);
    done += n;
    onProgress?.(done, count);
  }
  return done;
}

export async function insertTrucks(pool, { count, owners, seed = 2, batch = 2000 }) {
  const rnd = prng(seed);
  const cities = await loadCities(pool);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const dests = ['Anywhere', 'Anywhere / Kazakhstan / Russia', 'Moscow', 'Tashkent / Samarkand', 'Any direction', 'Almaty'];
  let done = 0;
  while (done < count) {
    const n = Math.min(batch, count - done);
    const c = { owner: [], id: [], label: [], lat: [], lng: [], dest: [], equip: [], cap: [], from: [], to: [], rate: [], comp: [] };
    for (let i = 0; i < n; i += 1) {
      const city = pick(cities);
      const owner = pick(owners);
      const from = Math.floor(rnd() * 10);
      c.owner.push(owner.id); c.id.push(city.id); c.label.push(city.label); c.lat.push(city.lat); c.lng.push(city.lng);
      c.dest.push(pick(dests)); c.equip.push(pick(EQUIP_BAG)); c.cap.push(Math.round((10 + rnd() * 15) * 2) / 2);
      c.from.push(isoDay(from)); c.to.push(rnd() < 0.5 ? isoDay(from + 3 + Math.floor(rnd() * 20)) : null);
      c.rate.push(rnd() < 0.3 ? null : Math.round(800 + rnd() * 3000)); c.comp.push(owner.company);
    }
    await pool.query(
      `INSERT INTO trucks (owner_id, loc_city_id, loc_city, loc_lat, loc_lng, dest_pref, equip, capacity_t, available_from, available_to,
                           min_rate_usd, company_name, contact_phone, contact_tg)
       SELECT o, i, l, la, ln, d, e, cp, f::date, t::date, r, cm, '+998 71 000 00 00', '@dispatch_bot'
         FROM unnest($1::bigint[], $2::int[], $3::text[], $4::float8[], $5::float8[], $6::text[], $7::text[], $8::numeric[],
                     $9::text[], $10::text[], $11::numeric[], $12::text[]) AS u(o, i, l, la, ln, d, e, cp, f, t, r, cm)`,
      [c.owner, c.id, c.label, c.lat, c.lng, c.dest, c.equip, c.cap, c.from, c.to, c.rate, c.comp]);
    done += n;
  }
  return done;
}

/** Create `count` approved demo members and return their rows. */
export async function insertMembers(pool, { count, prefix = 'carrier' }) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    const { rows: [m] } = await pool.query(
      `INSERT INTO members (email, company, contact_name, phone, telegram, status, reviewed_at)
       VALUES ($1, $2, $3, '+998 71 111 22 33', '@carrier_disp', 'approved', now())
       ON CONFLICT (email) DO UPDATE SET status = 'approved' RETURNING *`,
      [`${prefix}${i}@example.com`, `${prefix.toUpperCase()} ${i} Logistics LLC`, `Dispatcher ${i}`]);
    rows.push(m);
  }
  return rows;
}
