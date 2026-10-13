import { idParam, truckBody, truckPatchBody, truckQuery, trucksBulkBody } from '../lib/schemas.js';
import { likePattern, truckDto } from '../lib/dto.js';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors.js';
import { detail } from '../lib/validation.js';
import { createBinder, keyset, nextCursorFrom, radiusFilter } from '../lib/sql.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';
import { createMemberLimiter } from '../lib/memberlimit.js';

const COUNT_CAP = 10_000;

const LIST_COLS = `t.id, t.owner_id, (extract(epoch from t.created_at) * 1000)::bigint AS created_ms,
  t.loc_city_id, t.loc_city, t.dest_pref, t.equip, t.capacity_t, t.volume_m3, t.available_from, t.available_to,
  t.min_rate_usd, t.has_tir, t.has_adr, t.has_gps, t.side_loading, t.notes, t.company_name, t.contact_phone, t.contact_tg`;

const SORTS = {
  created: { col: 't.id', cast: 'bigint' },
  available: { col: 't.available_from', cast: 'date' },
  loc: { col: 't.loc_city', cast: 'text' },
  equip: { col: 't.equip', cast: 'text' },
  capacity: { col: 't.capacity_t', cast: 'numeric' },
  rate: { col: 'COALESCE(t.min_rate_usd, 0)', cast: 'numeric' }, // "negotiable" sorts as 0
};

export default async function truckRoutes(app, { pool, config }) {
  const approved = { preHandler: app.guards.active };
  // Writes: a per-member budget (after sign-in) plus the ordinary per-IP backstop. See lib/memberlimit.js for why
  // it is per member and not per IP (the Telegram bot posts for many members from one address).
  const memberWrites = createMemberLimiter({ max: config.writeRateLimitPerMin });
  const write = { preHandler: [...app.guards.active, memberWrites] };
  const countCached = (sql, params) => app.countCache.getOrLoad(`${sql}|${JSON.stringify(params)}`, () => pool.query(sql, params));

  app.get('/api/trucks', approved, async (req) => {
    const q = truckQuery.parse(req.query);
    const b = createBinder();
    // Trucks leave the board by themselves: explicit end date, else 30 days after availability starts.
    const where = [`t.status = 'active'`, `t.expires_on >= current_date`];
    let dhoSql = 'NULL::int';

    const near = q.nearLat !== undefined ? { lat: q.nearLat, lng: q.nearLng } : null;
    if (near) { // "near me": trucks within locRadius km of the person's own position
      const f = radiusFilter(b, { latCol: 't.loc_lat', lngCol: 't.loc_lng', city: near, radiusKm: q.locRadius });
      where.push(...f.clauses);
      dhoSql = `round(${f.distSql})::int`;
    }
    if (q.loc) {
      const city = await app.cityById(q.loc);
      if (!city) throw badRequest('Unknown location city');
      const f = radiusFilter(b, { latCol: 't.loc_lat', lngCol: 't.loc_lng', city, radiusKm: q.locRadius });
      where.push(...f.clauses);
      dhoSql = `round(${f.distSql})::int`;
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
    const sorts = hasCenter ? { ...SORTS, nearest: { col: dhoSql, cast: 'integer' } } : SORTS;
    const sort = q.sort === 'nearest' && !hasCenter ? 'created' : q.sort;
    const ks = keyset(b, { sorts, sort, dir: q.sort === 'nearest' && !hasCenter ? 'desc' : q.dir, cursor: q.cursor, idCol: 't.id' });
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

  // Shared by single create and bulk create (the AI "paste trucks" import): validates dates, enforces the quotas for
  // `bodies.length` trucks under the member's advisory lock, inserts them and announces each one.
  async function createTrucks(member, bodies, pathPrefix = '') {
    const at = (i, f) => (pathPrefix ? `${pathPrefix}.${i}.${f}` : f);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    bodies.forEach((body, i) => {
      if (body.availableFrom < yesterday) throw badRequest('Available-from date is in the past', [detail(at(i, 'availableFrom'), 'available_past')]);
      if (body.availableTo && body.availableTo < body.availableFrom) throw badRequest('End date is before start', [detail(at(i, 'availableTo'), 'end_before_start')]);
    });
    return withTx(pool, async (db) => {
      const ids = [...new Set(bodies.map((b) => b.locCityId))];
      const { rows: cityRows } = await db.query('SELECT id, label, lat, lng FROM cities WHERE id = ANY($1::int[])', [ids]);
      const cities = new Map(cityRows.map((c) => [c.id, c]));
      bodies.forEach((body, i) => { if (!cities.get(body.locCityId)) throw badRequest('Unknown location city', [detail(at(i, 'locCityId'), 'pick_city')]); });

      await db.query('SELECT pg_advisory_xact_lock($1)', [member.id]);
      // Two index-served counts (a single FILTERed count would scan the member's whole history).
      const [{ rows: [{ active }] }, { rows: [{ lasthour }] }] = await Promise.all([
        db.query(`SELECT count(*)::int AS active FROM trucks WHERE owner_id = $1 AND status = 'active'`, [member.id]),
        db.query(`SELECT count(*)::int AS lasthour FROM trucks WHERE owner_id = $1 AND created_at > now() - interval '1 hour'`, [member.id]),
      ]);
      if (active + bodies.length > config.maxActiveTrucksPerMember) throw tooMany(`You have reached the limit of ${config.maxActiveTrucksPerMember} active trucks.`);
      if (lasthour + bodies.length > config.maxPostsPerHour) throw tooMany('Posting too fast - please try again later.');

      const rows = [];
      for (const body of bodies) {
        const city = cities.get(body.locCityId);
        const { rows: [row] } = await db.query(
          `INSERT INTO trucks (owner_id, loc_city_id, loc_city, loc_lat, loc_lng, dest_pref, equip, capacity_t, volume_m3,
                               available_from, available_to, min_rate_usd, has_tir, has_adr, has_gps, side_loading,
                               company_name, contact_phone, contact_tg, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
          [member.id, city.id, city.label, city.lat, city.lng, body.destPref, body.equip, body.capacityT, body.volumeM3,
            body.availableFrom, body.availableTo, body.minRateUsd, body.hasTir, body.hasAdr, body.hasGps, body.sideLoading,
            member.company, body.contactPhone, body.contactTelegram, body.notes ?? '']);
        await publish(db, { entity: 'trucks', op: 'insert', id: row.id, ownerId: member.id });
        rows.push(row);
      }
      return rows;
    });
  }

  app.post('/api/trucks', write, async (req, reply) => {
    const [created] = await createTrucks(req.member, [truckBody.parse(req.body)]);
    return reply.code(201).send(truckDto(created, req.member.id));
  });

  // Up to 40 trucks at once (used by "paste trucks"). All-or-nothing, errors point at `trucks.<index>.<field>`.
  app.post('/api/trucks/bulk', write, async (req, reply) => {
    const { trucks } = trucksBulkBody.parse(req.body);
    const created = await createTrucks(req.member, trucks, 'trucks');
    return reply.code(201).send({ items: created.map((r) => truckDto(r, req.member.id)) });
  });

  // Edit a posted truck (the owner, or the platform owner). Omitted fields stay as they are.
  app.patch('/api/trucks/:id', write, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = truckPatchBody.parse(req.body);
    const updated = await withTx(pool, async (db) => {
      const { rows: [cur] } = await db.query(`SELECT * FROM trucks WHERE id = $1 AND status = 'active' FOR UPDATE`, [id]);
      if (!cur) throw notFound('Truck not found');
      if (cur.owner_id !== req.member.id && req.member.role !== 'owner') throw forbidden('You can only edit your own trucks');
      const phoneAfter = patch.contactPhone ?? cur.contact_phone;
      const tgAfter = patch.contactTelegram ?? cur.contact_tg;
      if (!phoneAfter && !tgAfter) throw badRequest('Add a phone number or a Telegram username', [detail('contactPhone', 'contact_required'), detail('contactTelegram', 'contact_required')]);
      const day = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
      const fromS = day(patch.availableFrom ?? cur.available_from);
      const toS = day(patch.availableTo === undefined ? cur.available_to : patch.availableTo);
      if (toS && toS < fromS) throw badRequest('End date is before start', [detail('availableTo', 'end_before_start')]);
      let city = { id: cur.loc_city_id, label: cur.loc_city, lat: cur.loc_lat, lng: cur.loc_lng };
      if (patch.locCityId !== undefined && patch.locCityId !== cur.loc_city_id) {
        const { rows: [c] } = await db.query('SELECT id, label, lat, lng FROM cities WHERE id = $1', [patch.locCityId]);
        if (!c) throw badRequest('Unknown location city', [detail('locCityId', 'pick_city')]);
        city = c;
      }
      const pick = (k, col) => (patch[k] === undefined ? cur[col] : patch[k]);
      const { rows: [row] } = await db.query(
        `UPDATE trucks SET loc_city_id = $2, loc_city = $3, loc_lat = $4, loc_lng = $5, dest_pref = $6, equip = $7, capacity_t = $8,
                volume_m3 = $9, available_from = $10, available_to = $11, min_rate_usd = $12, has_tir = $13, has_adr = $14,
                has_gps = $15, side_loading = $16, notes = $17, contact_phone = $18, contact_tg = $19, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, city.id, city.label, city.lat, city.lng, pick('destPref', 'dest_pref'), pick('equip', 'equip'), pick('capacityT', 'capacity_t'),
          pick('volumeM3', 'volume_m3'), fromS, toS || null, pick('minRateUsd', 'min_rate_usd'), pick('hasTir', 'has_tir'), pick('hasAdr', 'has_adr'),
          pick('hasGps', 'has_gps'), pick('sideLoading', 'side_loading'), pick('notes', 'notes'), phoneAfter, tgAfter]);
      await publish(db, { entity: 'trucks', op: 'update', id, ownerId: cur.owner_id });
      return row;
    });
    return truckDto(updated, req.member.id);
  });

  // "Still available": the truck counts from today again (its 30 days start over; a fixed end date is dropped).
  app.post('/api/trucks/:id/renew', write, async (req) => {
    const { id } = idParam.parse(req.params);
    const row = await withTx(pool, async (db) => {
      const { rows: [r] } = await db.query(
        `UPDATE trucks SET available_from = current_date, available_to = NULL, created_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'active' AND owner_id = $2 RETURNING *`, [id, req.member.id]);
      if (!r) {
        const { rows: [exists] } = await db.query(`SELECT 1 FROM trucks WHERE id = $1 AND status = 'active'`, [id]);
        throw exists ? forbidden('You can only renew your own trucks') : notFound('Truck not found');
      }
      await publish(db, { entity: 'trucks', op: 'update', id, ownerId: r.owner_id });
      return r;
    });
    return truckDto(row, req.member.id);
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
