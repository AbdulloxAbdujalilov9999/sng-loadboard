import { directoryQuery } from '../lib/schemas.js';
import { directoryDto, likePattern } from '../lib/dto.js';
import { createBinder, keyset, nextCursorFrom } from '../lib/sql.js';

const SORTS = { company: { col: 'm.company', cast: 'text' } };

// Carrier directory = approved members (the owner account is excluded). Public fields only.
export default async function directoryRoutes(app, { pool }) {
  app.get('/api/directory', { preHandler: app.guards.approved }, async (req) => {
    const q = directoryQuery.parse(req.query);
    const b = createBinder();
    const where = [`m.status = 'approved'`, `m.role = 'member'`];
    if (q.q) {
      const p = b.P(likePattern(q.q));
      where.push(`(m.company ILIKE ${p} OR m.location ILIKE ${p} OR m.tir_carnet ILIKE ${p} OR m.routes ILIKE ${p} OR m.contact_name ILIKE ${p})`);
    }
    const filterCount = b.params.length;
    const filterSql = where.join(' AND ');
    const ks = keyset(b, { sorts: SORTS, sort: 'company', dir: 'asc', cursor: q.cursor, idCol: 'm.id' });
    if (ks.cursorClause) where.push(ks.cursorClause);

    const [list, count] = await Promise.all([
      pool.query(`SELECT m.*, ${ks.sortValueSql} AS _sv FROM members m WHERE ${where.join(' AND ')}
                   ORDER BY ${ks.orderBy} LIMIT ${q.limit + 1}`, b.params),
      q.cursor ? null : pool.query(`SELECT count(*)::int AS n FROM members m WHERE ${filterSql}`, b.params.slice(0, filterCount)),
    ]);
    const hasMore = list.rows.length > q.limit;
    const rows = hasMore ? list.rows.slice(0, q.limit) : list.rows;
    return {
      items: rows.map(directoryDto),
      nextCursor: hasMore ? nextCursorFrom(rows.at(-1)) : null,
      ...(count ? { total: count.rows[0].n } : {}),
    };
  });
}
