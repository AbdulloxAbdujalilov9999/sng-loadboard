import { idParam, loadBody, loadPatchBody, loadQuery, loadsBulkBody } from '../lib/schemas.js';
import { likePattern, loadDto } from '../lib/dto.js';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors.js';
import { detail } from '../lib/validation.js';
import { roadDistanceKm } from '../lib/geo.js';
import { createBinder, keyset, nextCursorFrom, radiusFilter } from '../lib/sql.js';
import { publish } from '../events.js';
import { withTx } from '../db.js';

const COUNT_CAP = 10_000;

// Only the columns the board shows. SELECT * made the API spend most of its CPU decoding data nobody
// reads (coordinates, search_text, three timestamps) - trimming it roughly doubled throughput.
const LIST_COLS = `l.id, l.owner_id, (extract(epoch from l.created_at) * 1000)::bigint AS created_ms,
  l.origin_city_id, l.origin_city, l.dest_city_id, l.dest_city, l.equip, l.fp, l.weight_t, l.volume_m3,
  l.pickup_date, l.delivery_date, l.distance_km, l.rate_usd, l.commodity, l.notes, l.company_name,
  l.contact_name, l.contact_phone, l.contact_email, l.contact_tg`; // "10,000+" - counting further buys nothing and costs time

// API sort name -> column + cast used when binding the keyset cursor value.
const SORTS = {
  created: { col: 'l.id', cast: 'bigint' },
  pickup: { col: 'l.pickup_date', cast: 'date' },
  origin: { col: 'l.origin_city', cast: 'text' },
  dest: { col: 'l.dest_city', cast: 'text' },
  equip: { col: 'l.equip', cast: 'text' },
  weight: { col: 'l.weight_t', cast: 'numeric' },
  distance: { col: 'l.distance_km', cast: 'integer' },
  rate: { col: 'l.rate_usd', cast: 'numeric' },
  company: { col: 'l.company_name', cast: 'text' },
};

async function getCities(db, ids) {
  const { rows } = await db.query('SELECT id, label, lat, lng FROM cities WHERE id = ANY($1::int[])', [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

function assertDates(pickup, delivery) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const maxAhead = new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10);
  if (pickup < yesterday) throw badRequest('Pickup date is in the past', [detail('pickupDate', 'pickup_past')]);
  if (pickup > maxAhead) throw badRequest('Pickup date is too far ahead', [detail('pickupDate', 'pickup_far')]);
  if (delivery && delivery < pickup) throw badRequest('Delivery is before pickup', [detail('deliveryDate', 'delivery_before_pickup')]);
  return today;
}

export default async function loadRoutes(app, { pool, config }) {
  const approved = { preHandler: app.guards.approved };
  const write = { preHandler: app.guards.approved, config: { rateLimit: { max: config.writeRateLimitPerMin, timeWindow: '1 minute' } } };
  const countCached = (sql, params) => app.countCache.getOrLoad(`${sql}|${JSON.stringify(params)}`, () => pool.query(sql, params));

  // ---------- search ----------
  app.get('/api/loads', approved, async (req) => {
    const q = loadQuery.parse(req.query);
    const b = createBinder();
    const where = [`l.status = 'active'`, `l.pickup_date >= current_date - 1`];
    let dhoSql = 'NULL::int';
    let dhdSql = 'NULL::int';

    for (const [key, prefix, radius, outKey] of [['origin', 'origin', q.originRadius, 'dho'], ['dest', 'dest', q.destRadius, 'dhd']]) {
      if (!q[key]) continue;
      const city = await app.cityById(q[key]);
      if (!city) throw badRequest(`Unknown ${key} city`);
      const f = radiusFilter(b, { latCol: `l.${prefix}_lat`, lngCol: `l.${prefix}_lng`, city, radiusKm: radius });
      where.push(...f.clauses);
      if (outKey === 'dho') dhoSql = `round(${f.distSql})::int`; else dhdSql = `round(${f.distSql})::int`;
    }
    if (q.equip?.length) where.push(`l.equip = ANY(${b.P(q.equip)}::text[])`);
    if (q.fp) where.push(`l.fp = ${b.P(q.fp)}`);
    if (q.dateFrom) where.push(`l.pickup_date >= ${b.P(q.dateFrom)}::date`);
    if (q.dateTo) where.push(`l.pickup_date <= ${b.P(q.dateTo)}::date`);
    if (q.minWeight !== undefined) where.push(`l.weight_t >= ${b.P(q.minWeight)}`);
    if (q.maxWeight !== undefined) where.push(`l.weight_t <= ${b.P(q.maxWeight)}`);
    if (q.minRate !== undefined) where.push(`l.rate_usd >= ${b.P(q.minRate)}`);
    if (q.maxDistance !== undefined) where.push(`l.distance_km <= ${b.P(q.maxDistance)}`);
    if (q.q) {
      const p = b.P(likePattern(q.q));
      where.push(`l.search_text ILIKE ${p}`); // trigram-indexed (see migration 003)
    }
    const filterCount = b.params.length;
    const filterSql = where.join(' AND ');

    const ks = keyset(b, { sorts: SORTS, sort: q.sort, dir: q.dir, cursor: q.cursor, idCol: 'l.id' });
    if (ks.cursorClause) where.push(ks.cursorClause);

    const listSql = `SELECT ${LIST_COLS}, ${dhoSql} AS dho, ${dhdSql} AS dhd, ${ks.sortValueSql} AS _sv
                       FROM loads l WHERE ${where.join(' AND ')}
                      ORDER BY ${ks.orderBy} LIMIT ${q.limit + 1}`;
    const countSql = `SELECT count(*)::int AS n FROM (SELECT 1 FROM loads l WHERE ${filterSql} LIMIT ${COUNT_CAP + 1}) t`;

    // The total is only computed for the first page; later pages just stream rows.
    const [list, count] = await Promise.all([
      app.searchCache.getOrLoad(`L|${listSql}|${JSON.stringify(b.params)}`, () => pool.query(listSql, b.params)),
      q.cursor ? null : countCached(countSql, b.params.slice(0, filterCount)),
    ]);
    const hasMore = list.rows.length > q.limit;
    const rows = hasMore ? list.rows.slice(0, q.limit) : list.rows;
    return {
      items: rows.map((r) => loadDto(r, req.member.id)),
      nextCursor: hasMore ? nextCursorFrom(rows.at(-1)) : null,
      ...(count ? { total: Math.min(count.rows[0].n, COUNT_CAP), totalCapped: count.rows[0].n > COUNT_CAP } : {}),
    };
  });

  // Everything I have posted (including loads whose pickup date has passed, so I can still remove them).
  app.get('/api/loads/mine', approved, async (req) => {
    const { rows } = await pool.query(
      `SELECT l.* FROM loads l WHERE l.owner_id = $1 AND l.status = 'active' ORDER BY l.id DESC LIMIT 500`, [req.member.id]);
    return { items: rows.map((r) => loadDto(r, req.member.id)) };
  });

  // ---------- create ----------
  // Shared by single create and bulk create: validates cross-field rules, enforces quotas for `bodies.length`
  // new loads under the member's advisory lock, inserts them and announces each one.
  async function createLoads(member, bodies, pathPrefix = '') {
    const at = (i, f) => (pathPrefix ? `${pathPrefix}.${i}.${f}` : f);
    bodies.forEach((body, i) => {
      if (body.originCityId === body.destCityId) throw badRequest('Origin and destination must differ', [detail(at(i, 'destCityId'), 'dest_same_as_origin')]);
      try { assertDates(body.pickupDate, body.deliveryDate); } catch (e) {
        if (e.details) e.details = e.details.map((d) => ({ ...d, path: at(i, d.path) }));
        throw e;
      }
    });
    return withTx(pool, async (db) => {
      const ids = [...new Set(bodies.flatMap((b) => [b.originCityId, b.destCityId]))];
      const cities = await getCities(db, ids);
      bodies.forEach((body, i) => {
        if (!cities.get(body.originCityId)) throw badRequest('Unknown origin city', [detail(at(i, 'originCityId'), 'pick_city')]);
        if (!cities.get(body.destCityId)) throw badRequest('Unknown destination city', [detail(at(i, 'destCityId'), 'pick_city')]);
      });

      // Serialise this member's posting so the quota checks can't be raced by parallel requests.
      await db.query('SELECT pg_advisory_xact_lock($1)', [member.id]);
      // Two index-served counts (a single FILTERed count would scan the member's whole history).
      const [{ rows: [{ active }] }, { rows: [{ lasthour }] }] = await Promise.all([
        db.query(`SELECT count(*)::int AS active FROM loads WHERE owner_id = $1 AND status = 'active'`, [member.id]),
        db.query(`SELECT count(*)::int AS lasthour FROM loads WHERE owner_id = $1 AND created_at > now() - interval '1 hour'`, [member.id]),
      ]);
      if (active + bodies.length > config.maxActiveLoadsPerMember) throw tooMany(`You have reached the limit of ${config.maxActiveLoadsPerMember} active loads. Remove some to post more.`);
      if (lasthour + bodies.length > config.maxPostsPerHour) throw tooMany('Posting too fast - please try again later.');

      const rows = [];
      for (const body of bodies) {
        const o = cities.get(body.originCityId);
        const d = cities.get(body.destCityId);
        const { rows: [row] } = await db.query(
          `INSERT INTO loads (owner_id, origin_city_id, origin_city, origin_lat, origin_lng,
                              dest_city_id, dest_city, dest_lat, dest_lng, equip, fp, weight_t, volume_m3,
                              pickup_date, delivery_date, distance_km, rate_usd, commodity, notes, company_name,
                              contact_name, contact_phone, contact_email, contact_tg)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
           RETURNING *`,
          [member.id, o.id, o.label, o.lat, o.lng, d.id, d.label, d.lat, d.lng, body.equip, body.fp, body.weightT,
            body.volumeM3, body.pickupDate, body.deliveryDate, roadDistanceKm(o, d, config.roadFactor), body.rateUsd,
            body.commodity, body.notes ?? '', member.company, body.contactName, body.contactPhone, body.contactEmail, body.contactTelegram]);
        await publish(db, { entity: 'loads', op: 'insert', id: row.id, ownerId: member.id });
        rows.push(row);
      }
      return rows;
    });
  }

  app.post('/api/loads', write, async (req, reply) => {
    const [created] = await createLoads(req.member, [loadBody.parse(req.body)]);
    return reply.code(201).send(loadDto(created, req.member.id));
  });

  // Up to 40 loads at once (used by "paste from Telegram/WhatsApp"). All-or-nothing: one bad row rejects the
  // batch with errors pointing at `loads.<index>.<field>`, so nothing is half-posted.
  app.post('/api/loads/bulk', write, async (req, reply) => {
    const { loads } = loadsBulkBody.parse(req.body);
    const created = await createLoads(req.member, loads, 'loads');
    return reply.code(201).send({ items: created.map((r) => loadDto(r, req.member.id)) });
  });

  // ---------- edit ----------
  app.patch('/api/loads/:id', write, async (req) => {
    const { id } = idParam.parse(req.params);
    const patch = loadPatchBody.parse(req.body);

    const updated = await withTx(pool, async (db) => {
      const { rows: [cur] } = await db.query(`SELECT * FROM loads WHERE id = $1 AND status = 'active' FOR UPDATE`, [id]);
      if (!cur) throw notFound('Load not found');
      if (cur.owner_id !== req.member.id && req.member.role !== 'owner') throw forbidden('You can only edit your own loads');

      const originId = patch.originCityId ?? cur.origin_city_id;
      const destId = patch.destCityId ?? cur.dest_city_id;
      if (originId === destId) throw badRequest('Origin and destination must differ', [detail('destCityId', 'dest_same_as_origin')]);
      const cities = await getCities(db, [originId, destId]);
      const o = cities.get(originId);
      const d = cities.get(destId);
      if (!o || !d) throw badRequest('Unknown city');

      const pickup = patch.pickupDate ?? cur.pickup_date;
      const delivery = patch.deliveryDate === undefined ? cur.delivery_date : patch.deliveryDate;
      if (patch.pickupDate !== undefined) assertDates(pickup, delivery);
      else if (delivery && delivery < pickup) throw badRequest('Delivery is before pickup', [detail('deliveryDate', 'delivery_before_pickup')]);

      const { rows: [row] } = await db.query(
        `UPDATE loads SET
            origin_city_id = $2, origin_city = $3, origin_lat = $4, origin_lng = $5,
            dest_city_id = $6, dest_city = $7, dest_lat = $8, dest_lng = $9,
            equip = $10, fp = $11, weight_t = $12, volume_m3 = $13, pickup_date = $14, delivery_date = $15,
            distance_km = $16, rate_usd = $17, commodity = $18, notes = $23,
            contact_name = $19, contact_phone = $20, contact_email = $21, contact_tg = $22, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, o.id, o.label, o.lat, o.lng, d.id, d.label, d.lat, d.lng,
          patch.equip ?? cur.equip, patch.fp ?? cur.fp, patch.weightT ?? cur.weight_t,
          patch.volumeM3 === undefined ? cur.volume_m3 : patch.volumeM3, pickup, delivery,
          roadDistanceKm(o, d, config.roadFactor), patch.rateUsd ?? cur.rate_usd, patch.commodity ?? cur.commodity,
          patch.contactName ?? cur.contact_name, patch.contactPhone ?? cur.contact_phone,
          patch.contactEmail ?? cur.contact_email, patch.contactTelegram ?? cur.contact_tg, patch.notes ?? cur.notes]);
      await publish(db, { entity: 'loads', op: 'update', id, ownerId: cur.owner_id });
      return row;
    });
    return loadDto(updated, req.member.id);
  });

  // ---------- remove (soft: history is kept, the load just leaves the board) ----------
  app.delete('/api/loads/:id', write, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await withTx(pool, async (db) => {
      const { rows: [row] } = await db.query(
        `UPDATE loads SET status = 'closed', closed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'active' AND (owner_id = $2 OR $3::boolean) RETURNING id`,
        [id, req.member.id, req.member.role === 'owner']);
      if (!row) {
        const { rows: [exists] } = await db.query(`SELECT 1 FROM loads WHERE id = $1 AND status = 'active'`, [id]);
        throw exists ? forbidden('You can only remove your own loads') : notFound('Load not found');
      }
      await publish(db, { entity: 'loads', op: 'delete', id });
    });
    return reply.code(204).send();
  });
}
