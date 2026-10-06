import { boundingBox, haversineSql } from './geo.js';
import { decodeCursor, encodeCursor } from './cursor.js';

/** Tiny parameter binder: every user-supplied value goes through P(), never into the SQL text. */
export function createBinder() {
  const params = [];
  const P = (v) => { params.push(v); return `$${params.length}`; };
  const PF = (v) => `${P(v)}::float8`;
  return { params, P, PF };
}

/**
 * Radius ("deadhead") filter: a lat/lng bounding box the planner can range-scan, plus the exact
 * haversine on the survivors. Returns WHERE clauses and an SQL expression for the distance in km.
 */
export function radiusFilter(b, { latCol, lngCol, city, radiusKm }) {
  const box = boundingBox(city.lat, city.lng, radiusKm);
  const lat = b.PF(city.lat);
  const lng = b.PF(city.lng);
  const distSql = haversineSql(latCol, lngCol, lat, lng);
  return {
    clauses: [
      `${latCol} BETWEEN ${b.PF(box.latMin)} AND ${b.PF(box.latMax)}`,
      `${lngCol} BETWEEN ${b.PF(box.lngMin)} AND ${b.PF(box.lngMax)}`,
      `${distSql} <= ${b.PF(radiusKm + 0.01)}`,
    ],
    distSql,
  };
}

/**
 * Keyset pagination. `sorts` maps an API sort name to { col, cast }. Rows are ordered by
 * (col, id) in one direction so a row-value comparison against the cursor is an index range scan -
 * constant cost for page 1 and page 1000 alike (OFFSET would degrade linearly).
 * Returns { orderBy, cursorClause?, sortValueSql } - the caller appends cursorClause to WHERE.
 */
export function keyset(b, { sorts, sort, dir, cursor, idCol }) {
  const spec = sorts[sort];
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  const op = dir === 'asc' ? '>' : '<';
  const byId = spec.col === idCol;
  const orderBy = byId ? `${idCol} ${direction}` : `${spec.col} ${direction}, ${idCol} ${direction}`;
  let cursorClause = null;
  if (cursor) {
    const c = decodeCursor(cursor);
    cursorClause = byId
      ? `${idCol} ${op} ${b.P(c.id)}::bigint`
      : `(${spec.col}, ${idCol}) ${op} (${b.P(c.value)}::${spec.cast}, ${b.P(c.id)}::bigint)`;
  }
  return { orderBy, cursorClause, sortValueSql: `${spec.col}::text` };
}

/** Build the next-page cursor from the last row actually returned. */
export function nextCursorFrom(row) {
  return row ? encodeCursor(row._sv, row.id) : null;
}
