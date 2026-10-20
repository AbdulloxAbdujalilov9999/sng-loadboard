// A member's saved individual load/truck posts ("Saved" tab - loadme.uz's "Saqlanganlar"). Distinct
// from saved_searches (routes/savedSearches.js), which saves a *filter*, not a *post*. See
// migrations/027_favorites.sql for why there is no FK to loads/trucks.
import { favoriteBody, favoriteParams } from '../lib/schemas.js';
import { loadDto, truckDto } from '../lib/dto.js';
import { notFound, tooMany } from '../lib/errors.js';

const MAX_PER_MEMBER = 500;
const LOAD_COLS = `l.id, l.owner_id, (extract(epoch from l.created_at) * 1000)::bigint AS created_ms,
  l.origin_city_id, l.origin_city, l.origin_lat, l.origin_lng, l.dest_city_id, l.dest_city, l.dest_lat, l.dest_lng, l.equip, l.fp, l.weight_t, l.volume_m3,
  l.pickup_date, l.delivery_date, l.distance_km, l.rate_usd, l.commodity, l.notes, l.company_name,
  l.contact_name, l.contact_phone, l.contact_email, l.contact_tg`;
const TRUCK_COLS = `t.id, t.owner_id, (extract(epoch from t.created_at) * 1000)::bigint AS created_ms,
  t.loc_city_id, t.loc_city, t.dest_pref, t.equip, t.capacity_t, t.volume_m3, t.available_from, t.available_to,
  t.min_rate_usd, t.has_tir, t.has_adr, t.has_gps, t.side_loading, t.notes, t.company_name, t.contact_phone, t.contact_tg`;

export default async function favoriteRoutes(app, { pool }) {
  const approved = { preHandler: app.guards.active };

  // Favorited loads and favorited trucks, newest-saved first. A post that was closed (or purged) after
  // being saved simply does not come back - the favorite row is left alone (see the migration comment).
  app.get('/api/me/favorites', approved, async (req) => {
    const { rows: favs } = await pool.query(
      `SELECT id, entity_type, entity_id, created_at FROM favorites WHERE member_id = $1 ORDER BY id DESC LIMIT 500`, [req.member.id]);
    const loadIds = favs.filter((f) => f.entity_type === 'load').map((f) => f.entity_id);
    const truckIds = favs.filter((f) => f.entity_type === 'truck').map((f) => f.entity_id);
    const [loadsRes, trucksRes] = await Promise.all([
      loadIds.length ? pool.query(`SELECT ${LOAD_COLS} FROM loads l WHERE l.id = ANY($1::bigint[]) AND l.status = 'active'`, [loadIds]) : { rows: [] },
      truckIds.length ? pool.query(`SELECT ${TRUCK_COLS} FROM trucks t WHERE t.id = ANY($1::bigint[]) AND t.status = 'active'`, [truckIds]) : { rows: [] },
    ]);
    const loadById = new Map(loadsRes.rows.map((r) => [r.id, r]));
    const truckById = new Map(trucksRes.rows.map((r) => [r.id, r]));
    const items = favs.map((f) => {
      if (f.entity_type === 'load') {
        const row = loadById.get(f.entity_id);
        return row ? { id: f.id, entityType: 'load', createdAt: f.created_at, load: loadDto(row, req.member.id) } : null;
      }
      const row = truckById.get(f.entity_id);
      return row ? { id: f.id, entityType: 'truck', createdAt: f.created_at, truck: truckDto(row, req.member.id) } : null;
    }).filter(Boolean);
    return { items };
  });

  app.post('/api/me/favorites', approved, async (req, reply) => {
    const body = favoriteBody.parse(req.body);
    const table = body.entityType === 'load' ? 'loads' : 'trucks';
    const { rows: [exists] } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 AND status = 'active'`, [body.entityId]);
    if (!exists) throw notFound(body.entityType === 'load' ? 'Load not found' : 'Truck not found');
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM favorites WHERE member_id = $1', [req.member.id]);
    if (n >= MAX_PER_MEMBER) throw tooMany(`You have reached the limit of ${MAX_PER_MEMBER} saved posts. Remove one to save another.`);
    const { rows: [row] } = await pool.query(
      `INSERT INTO favorites (member_id, entity_type, entity_id) VALUES ($1, $2, $3)
       ON CONFLICT (member_id, entity_type, entity_id) DO UPDATE SET entity_type = EXCLUDED.entity_type
       RETURNING id, entity_type, entity_id, created_at`,
      [req.member.id, body.entityType, body.entityId]);
    return reply.code(201).send({ id: row.id, entityType: row.entity_type, entityId: row.entity_id, createdAt: row.created_at });
  });

  app.delete('/api/me/favorites/:entityType/:entityId', approved, async (req) => {
    const { entityType, entityId } = favoriteParams.parse(req.params);
    const { rowCount } = await pool.query(
      'DELETE FROM favorites WHERE member_id = $1 AND entity_type = $2 AND entity_id = $3', [req.member.id, entityType, entityId]);
    if (!rowCount) throw notFound('Not in your saved posts');
    return { ok: true };
  });
}
