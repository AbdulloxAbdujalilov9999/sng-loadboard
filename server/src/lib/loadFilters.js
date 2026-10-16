import { radiusFilter } from './sql.js';
import { likePattern } from './dto.js';
import { badRequest } from './errors.js';

/**
 * Turns a parsed `loadQuery` into WHERE clauses, appended via `b` (lib/sql.js's createBinder).
 * Shared by the live search (routes/loads.js) and the saved-search matcher
 * (lib/savedSearchAlerts.js), so both mean exactly the same thing by "this load matches this
 * search" - the same radius math, the same country/equip/date/etc. rules, one implementation.
 * Returns { where, dhoSql, dhdSql }: a caller that only needs a yes/no match (the alert check)
 * can ignore dhoSql/dhdSql, which exist for the live search's "deadhead distance" column.
 */
export async function buildLoadWhere(app, b, q) {
  const where = [];
  let dhoSql = 'NULL::int';
  let dhdSql = 'NULL::int';

  const near = q.nearLat !== undefined ? { lat: q.nearLat, lng: q.nearLng } : null;
  if (near) { // "near me": the same radius search as a picked origin city, around the person's own position
    const f = radiusFilter(b, { latCol: 'l.origin_lat', lngCol: 'l.origin_lng', city: near, radiusKm: q.originRadius });
    where.push(...f.clauses);
    dhoSql = `round(${f.distSql})::int`;
  }
  for (const [key, prefix, radius, outKey] of [['origin', 'origin', q.originRadius, 'dho'], ['dest', 'dest', q.destRadius, 'dhd']]) {
    if (!q[key]) continue;
    const city = await app.cityById(q[key]);
    if (!city) throw badRequest(`Unknown ${key} city`);
    const f = radiusFilter(b, { latCol: `l.${prefix}_lat`, lngCol: `l.${prefix}_lng`, city, radiusKm: radius });
    where.push(...f.clauses);
    if (outKey === 'dho') dhoSql = `round(${f.distSql})::int`; else dhdSql = `round(${f.distSql})::int`;
  }
  if (q.originCountry) where.push(`l.origin_country = ${b.P(q.originCountry)}`);
  if (q.destCountry) where.push(`l.dest_country = ${b.P(q.destCountry)}`);
  if (q.equip?.length) where.push(`l.equip = ANY(${b.P(q.equip)}::text[])`);
  if (q.fp) where.push(`l.fp = ${b.P(q.fp)}`);
  if (q.dateFrom) where.push(`l.pickup_date >= ${b.P(q.dateFrom)}::date`);
  if (q.dateTo) where.push(`l.pickup_date <= ${b.P(q.dateTo)}::date`);
  if (q.minWeight !== undefined) where.push(`l.weight_t >= ${b.P(q.minWeight)}`);
  if (q.maxWeight !== undefined) where.push(`l.weight_t <= ${b.P(q.maxWeight)}`);
  if (q.minRate !== undefined) where.push(`l.rate_usd >= ${b.P(q.minRate)}`);
  if (q.maxDistance !== undefined) where.push(`l.distance_km <= ${b.P(q.maxDistance)}`);
  if (q.q) where.push(`l.search_text LIKE ${b.P(likePattern(q.q))}`);
  return { where, dhoSql, dhdSql };
}
