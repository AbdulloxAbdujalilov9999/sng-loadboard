// Public, unauthenticated read-only browsing of the board - loadme.uz calls this "guest-loads" /
// "guest-trucks": the page Google and AI crawlers index, and the funnel that turns a visitor into a
// sign-up. Same search as the member board (lib/loadFilters.js, so "matches" means the same thing
// everywhere), capped lower and with contact details masked - see dto.js's guestLoadDto/guestTruckDto.
import { badRequest, notFound } from '../lib/errors.js';
import { guestLoadDto, guestTruckDto, likePattern } from '../lib/dto.js';
import { idParam, loadQuery, truckQuery } from '../lib/schemas.js';
import { createBinder, keyset, nextCursorFrom, radiusFilter } from '../lib/sql.js';
import { buildLoadWhere } from '../lib/loadFilters.js';

const COUNT_CAP = 10_000;
const GUEST_LIMIT_MAX = 30; // lower than the member board (100): guests browse, they don't need deep paging

const LOAD_COLS = `l.id, l.owner_id, (extract(epoch from l.created_at) * 1000)::bigint AS created_ms,
  l.origin_city_id, l.origin_city, l.origin_lat, l.origin_lng, l.dest_city_id, l.dest_city, l.dest_lat, l.dest_lng, l.equip, l.fp, l.weight_t, l.volume_m3,
  l.pickup_date, l.delivery_date, l.distance_km, l.rate_usd, l.commodity, l.notes, l.company_name,
  l.contact_name, l.contact_phone, l.contact_email, l.contact_tg`;
const LOAD_SORTS = {
  created: { col: 'l.id', cast: 'bigint' }, pickup: { col: 'l.pickup_date', cast: 'date' },
  origin: { col: 'l.origin_city', cast: 'text' }, dest: { col: 'l.dest_city', cast: 'text' },
  equip: { col: 'l.equip', cast: 'text' }, weight: { col: 'l.weight_t', cast: 'numeric' },
  distance: { col: 'l.distance_km', cast: 'integer' }, rate: { col: 'l.rate_usd', cast: 'numeric' }, company: { col: 'l.company_name', cast: 'text' },
};

const TRUCK_COLS = `t.id, t.owner_id, (extract(epoch from t.created_at) * 1000)::bigint AS created_ms,
  t.loc_city_id, t.loc_city, t.dest_pref, t.equip, t.capacity_t, t.volume_m3, t.available_from, t.available_to,
  t.min_rate_usd, t.has_tir, t.has_adr, t.has_gps, t.side_loading, t.notes, t.company_name, t.contact_phone, t.contact_tg`;
const TRUCK_SORTS = {
  created: { col: 't.id', cast: 'bigint' }, available: { col: 't.available_from', cast: 'date' }, loc: { col: 't.loc_city', cast: 'text' },
  equip: { col: 't.equip', cast: 'text' }, capacity: { col: 't.capacity_t', cast: 'numeric' }, rate: { col: 'COALESCE(t.min_rate_usd, 0)', cast: 'numeric' },
};

const guestRateLimit = { max: 120, timeWindow: '1 minute' }; // generous (crawlers + anonymous visitors), still bounded

export default async function guestRoutes(app, { pool }) {
  const guest = { config: { rateLimit: guestRateLimit } };
  const countCached = (sql, params) => app.countCache.getOrLoad(`g|${sql}|${JSON.stringify(params)}`, () => pool.query(sql, params));

  app.get('/api/guest/loads', guest, async (req) => {
    const q = loadQuery.parse({ ...req.query, limit: Math.min(Number(req.query.limit ?? GUEST_LIMIT_MAX), GUEST_LIMIT_MAX) });
    const b = createBinder();
    const where = [`l.status = 'active'`, `l.pickup_date >= current_date - 1`];
    const built = await buildLoadWhere(app, b, q);
    where.push(...built.where);
    const filterCount = b.params.length;
    const filterSql = where.join(' AND ');

    const hasCenter = Boolean(q.nearLat !== undefined || q.origin);
    const sorts = hasCenter ? { ...LOAD_SORTS, nearest: { col: built.dhoSql, cast: 'integer' } } : LOAD_SORTS;
    const sort = q.sort === 'nearest' && !hasCenter ? 'created' : q.sort;
    const ks = keyset(b, { sorts, sort, dir: q.sort === 'nearest' && !hasCenter ? 'desc' : q.dir, cursor: q.cursor, idCol: 'l.id' });
    if (ks.cursorClause) where.push(ks.cursorClause);

    const listSql = `SELECT ${LOAD_COLS}, ${built.dhoSql} AS dho, ${built.dhdSql} AS dhd, ${ks.sortValueSql} AS _sv
                       FROM loads l WHERE ${where.join(' AND ')} ORDER BY ${ks.orderBy} LIMIT ${q.limit + 1}`;
    const countSql = `SELECT count(*)::int AS n FROM (SELECT 1 FROM loads l WHERE ${filterSql} LIMIT ${COUNT_CAP + 1}) t`;
    const [list, count] = await Promise.all([
      app.searchCache.getOrLoad(`gL|${listSql}|${JSON.stringify(b.params)}`, () => pool.query(listSql, b.params)),
      q.cursor ? null : countCached(countSql, b.params.slice(0, filterCount)),
    ]);
    const hasMore = list.rows.length > q.limit;
    const rows = hasMore ? list.rows.slice(0, q.limit) : list.rows;
    return {
      items: rows.map(guestLoadDto),
      nextCursor: hasMore ? nextCursorFrom(rows.at(-1)) : null,
      ...(count ? { total: Math.min(count.rows[0].n, COUNT_CAP), totalCapped: count.rows[0].n > COUNT_CAP } : {}),
    };
  });

  app.get('/api/guest/loads/:id', guest, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows: [row] } = await pool.query(`SELECT ${LOAD_COLS} FROM loads l WHERE l.id = $1 AND l.status = 'active'`, [id]);
    if (!row) throw notFound('Load not found - it may have been closed or removed');
    return guestLoadDto(row);
  });

  app.get('/api/guest/trucks', guest, async (req) => {
    const q = truckQuery.parse({ ...req.query, limit: Math.min(Number(req.query.limit ?? GUEST_LIMIT_MAX), GUEST_LIMIT_MAX) });
    const b = createBinder();
    const where = [`t.status = 'active'`, `t.expires_on >= current_date`];
    let dhoSql = 'NULL::int';
    const near = q.nearLat !== undefined ? { lat: q.nearLat, lng: q.nearLng } : null;
    if (near) {
      const f = radiusFilter(b, { latCol: 't.loc_lat', lngCol: 't.loc_lng', city: near, radiusKm: q.locRadius });
      where.push(...f.clauses); dhoSql = `round(${f.distSql})::int`;
    }
    if (q.loc) {
      const city = await app.cityById(q.loc);
      if (!city) throw badRequest('Unknown location city');
      const f = radiusFilter(b, { latCol: 't.loc_lat', lngCol: 't.loc_lng', city, radiusKm: q.locRadius });
      where.push(...f.clauses); dhoSql = `round(${f.distSql})::int`;
    }
    if (q.locCountry) where.push(`t.loc_country = ${b.P(q.locCountry)}`);
    if (q.equip?.length) where.push(`t.equip = ANY(${b.P(q.equip)}::text[])`);
    if (q.dest) where.push(`(sng_fold(t.dest_pref) LIKE ${b.P(likePattern(q.dest))} OR sng_fold(t.dest_pref) LIKE 'any%' OR sng_fold(t.dest_pref) LIKE 'везде%' OR sng_fold(t.dest_pref) LIKE 'любое%' OR sng_fold(t.dest_pref) LIKE 'hamma%')`);
    if (q.availableOn) {
      const p = b.P(q.availableOn);
      where.push(`t.available_from <= ${p}::date AND t.expires_on >= ${p}::date`);
    }
    if (q.minCapacity !== undefined) where.push(`t.capacity_t >= ${b.P(q.minCapacity)}`);
    const filterCount = b.params.length;
    const filterSql = where.join(' AND ');

    const hasCenter = Boolean(near || q.loc);
    const sorts = hasCenter ? { ...TRUCK_SORTS, nearest: { col: dhoSql, cast: 'integer' } } : TRUCK_SORTS;
    const sort = q.sort === 'nearest' && !hasCenter ? 'created' : q.sort;
    const ks = keyset(b, { sorts, sort, dir: q.sort === 'nearest' && !hasCenter ? 'desc' : q.dir, cursor: q.cursor, idCol: 't.id' });
    if (ks.cursorClause) where.push(ks.cursorClause);

    const listSql = `SELECT ${TRUCK_COLS}, ${dhoSql} AS dho, ${ks.sortValueSql} AS _sv FROM trucks t
                   WHERE ${where.join(' AND ')} ORDER BY ${ks.orderBy} LIMIT ${q.limit + 1}`;
    const [list, count] = await Promise.all([
      app.searchCache.getOrLoad(`gT|${listSql}|${JSON.stringify(b.params)}`, () => pool.query(listSql, b.params)),
      q.cursor ? null : countCached(`SELECT count(*)::int AS n FROM (SELECT 1 FROM trucks t WHERE ${filterSql} LIMIT ${COUNT_CAP + 1}) x`, b.params.slice(0, filterCount)),
    ]);
    const hasMore = list.rows.length > q.limit;
    const rows = hasMore ? list.rows.slice(0, q.limit) : list.rows;
    return {
      items: rows.map(guestTruckDto),
      nextCursor: hasMore ? nextCursorFrom(rows.at(-1)) : null,
      ...(count ? { total: Math.min(count.rows[0].n, COUNT_CAP), totalCapped: count.rows[0].n > COUNT_CAP } : {}),
    };
  });

  app.get('/api/guest/trucks/:id', guest, async (req) => {
    const { id } = idParam.parse(req.params);
    const { rows: [row] } = await pool.query(`SELECT ${TRUCK_COLS} FROM trucks t WHERE t.id = $1 AND t.status = 'active'`, [id]);
    if (!row) throw notFound('Truck not found - it may have been closed or removed');
    return guestTruckDto(row);
  });
}
