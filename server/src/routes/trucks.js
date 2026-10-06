import { idParam, truckBody, truckQuery } from '../lib/schemas.js';
import { likePattern, truckDto } from '../lib/dto.js';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors.js';
import { detail } from '../lib/validation.js';
import { createBinder, keyset, nextCursorFrom, radiusFilter } from '../lib/sql.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';

const COUNT_CAP = 10_000;

const LIST_COLS = `t.id, t.owner_id, (extract(epoch from t.created_at) * 1000)::bigint AS created_ms,
  t.loc_city_id, t.loc_city, t.dest_pref, t.equip, t.capacity_t, t.volume_m3, t.available_from, t.available_to,
  t.min_rate_usd, t.has_tir, t.has_adr, t.has_gps, t.side_loading, t.company_name, t.contact_phone, t.contact_tg`;

const SORTS = {
  created: { col: 't.id', cast: 'bigint' },
  available: { col: 't.available_from', cast: 'date' },
  loc: { col: 't.loc_city', cast: 'text' },
  equip: { col: 't.equip', cast: 'text' },
  capacity: { col: 't.capacity_t', cast: 'numeric' },
  rate: { col: 'COALESCE(t.min_rate_usd, 0)', cast: 'numeric' }, // "negotiable" sorts as 0
};

export default async function truckRoutes(app, { pool, config }) {
  const approved = { preHandler: app.guards.approved };
  const write = { preHandler: app.guards.approved, config: { rateLimit: { max: config.writeRateLimitPerMin, timeWindow: '1 minute' } } };
  const countCached = (sql, params) => app.countCache.getOrLoad(`${sql}|${JSON.stringify(params)}`, () => pool.query(sql, params));

  app.get('/api/trucks', approved, async (req) => {
    const q = truckQuery.parse(req.query);
    const b = createBinder();
    // Trucks leave the board by themselves: explicit end date, else 30 days after availability starts.
    const where = [`t.status = 'active'`, `t.expires_on >= current_date`];
    let dhoSql = 'NULL::int';

    if (q.loc) {
      const city = await app.cityById(q.loc);
      if (!city) throw badRequest('Unknown location city');
      const f = radiusFilter(b, { latCol: 't.loc_lat', lngCol: 't.loc_lng', city, radiusKm: q.locRadius });
      where.push(...f.clauses);
      dhoSql = `round(${f.distSql})::int`;
    }
    if (q.equip?.length) where.push(`t.equip = ANY(${b.P(q.equip)}::text[])`);
    if (q.dest) where.push(`(t.dest_pref ILIKE ${b.P(likePattern(q.dest))} OR t.dest_pref ILIKE 'any%')`);
    if (q.availableOn) {
      const p = b.P(q.availableOn);
      where.push(`t.available_from <= ${p}::date AND t.expires_on >= ${p}::date`);
    }
    if (q.minCapacity !== undefined) where.push(`t.capacity_t >= ${b.P(q.minCapacity)}`);
    const filterCount = b.params.length;
    const filterSql = where.join(' AND ');

    const ks = keyset(b, { sorts: SORTS, sort: q.sort, dir: q.dir, cursor: q.cursor, idCol: 't.id' });
    if (ks.cursorClause) where.push(ks.cursorClause);

    const listSql = `SELECT ${LIST_COLS}, ${dhoSql} AS dho, ${ks.sortValueSql} AS _sv FROM trucks t
                   WHERE ${where.join(' AND ')} ORDER BY ${ks.orderBy} LIMIT ${q.limit + 1}`;
    const [list, count] = await Promise.all([
      app.searchCache.getOrLoad(`T|${listSql}|${JSON.stringify(b.params)}`, () => pool.query(listSql, b.params)),
      q.cursor ? null : countCached(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM trucks t WHERE ${filterSql} LIMIT ${COUNT_CAP + 1}) x`,
        b.params.slice(0, filterCount)),
    ]);
    const hasMore = list.rows.length > q.limit;
    const rows = hasMore ? list.rows.slice(0, q.limit) : list.rows;
    return {
      items: rows.map((r) => truckDto(r, req.member.id)),
      nextCursor: hasMore ? nextCursorFrom(rows.at(-1)) : null,
      ...(count ? { total: Math.min(count.rows[0].n, COUNT_CAP), totalCapped: count.rows[0].n > COUNT_CAP } : {}),
    };
  });

  app.get('/api/trucks/mine', approved, async (req) => {
    const { rows } = await pool.query(
      `SELECT t.* FROM trucks t WHERE t.owner_id = $1 AND t.status = 'active' ORDER BY t.id DESC LIMIT 200`, [req.member.id]);
    return { items: rows.map((r) => truckDto(r, req.member.id)) };
  });

  app.post('/api/trucks', write, async (req, reply) => {
    const body = truckBody.parse(req.body);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (body.availableFrom < yesterday) throw badRequest('Available-from date is in the past', [detail('availableFrom', 'available_past')]);
    if (body.availableTo && body.availableTo < body.availableFrom) throw badRequest('End date is before start', [detail('availableTo', 'end_before_start')]);

    const created = await withTx(pool, async (db) => {
      const { rows: [city] } = await db.query('SELECT id, label, lat, lng FROM cities WHERE id = $1', [body.locCityId]);
      if (!city) throw badRequest('Unknown location city', [detail('locCityId', 'pick_city')]);

      await db.query('SELECT pg_advisory_xact_lock($1)', [req.member.id]);
      // Two index-served counts (a single FILTERed count would scan the member's whole history).
      const [{ rows: [{ active }] }, { rows: [{ lasthour }] }] = await Promise.all([
        db.query(`SELECT count(*)::int AS active FROM trucks WHERE owner_id = $1 AND status = 'active'`, [req.member.id]),
        db.query(`SELECT count(*)::int AS lasthour FROM trucks WHERE owner_id = $1 AND created_at > now() - interval '1 hour'`, [req.member.id]),
      ]);
      if (active >= config.maxActiveTrucksPerMember) throw tooMany(`You have reached the limit of ${config.maxActiveTrucksPerMember} active trucks.`);
      if (lasthour >= config.maxPostsPerHour) throw tooMany('Posting too fast - please try again later.');

      const { rows: [row] } = await db.query(
        `INSERT INTO trucks (owner_id, loc_city_id, loc_city, loc_lat, loc_lng, dest_pref, equip, capacity_t, volume_m3,
                             available_from, available_to, min_rate_usd, has_tir, has_adr, has_gps, side_loading,
                             company_name, contact_phone, contact_tg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [req.member.id, city.id, city.label, city.lat, city.lng, body.destPref, body.equip, body.capacityT, body.volumeM3,
          body.availableFrom, body.availableTo, body.minRateUsd, body.hasTir, body.hasAdr, body.hasGps, body.sideLoading,
          req.member.company, body.contactPhone, body.contactTelegram]);
      await publish(db, { entity: 'trucks', op: 'insert', id: row.id, ownerId: req.member.id });
      return row;
    });
    return reply.code(201).send(truckDto(created, req.member.id));
  });

  app.delete('/api/trucks/:id', write, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await withTx(pool, async (db) => {
      const { rows: [row] } = await db.query(
        `UPDATE trucks SET status = 'closed', closed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'active' AND (owner_id = $2 OR $3::boolean) RETURNING id`,
        [id, req.member.id, req.member.role === 'owner']);
      if (!row) {
        const { rows: [exists] } = await db.query(`SELECT 1 FROM trucks WHERE id = $1 AND status = 'active'`, [id]);
        throw exists ? forbidden('You can only remove your own trucks') : notFound('Truck not found');
      }
      await publish(db, { entity: 'trucks', op: 'delete', id });
    });
    return reply.code(204).send();
  });
}
