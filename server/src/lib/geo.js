export const EARTH_RADIUS_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Great-circle distance scaled by a road-winding factor: the "estimated route" shown on a load. */
export function roadDistanceKm(a, b, factor) {
  return Math.max(1, Math.round(haversineKm(a.lat, a.lng, b.lat, b.lng) * factor));
}

/** Lat/lng rectangle that fully contains a circle - lets Postgres use a btree range scan first. */
export function boundingBox(lat, lng, radiusKm) {
  const dLat = radiusKm / 110.574;
  const cos = Math.cos(rad(lat));
  const dLng = cos < 0.01 ? 180 : Math.min(180, radiusKm / (111.32 * cos));
  return { latMin: lat - dLat, latMax: lat + dLat, lngMin: lng - dLng, lngMax: lng + dLng };
}

/** SQL haversine (km) between a column pair and two bound parameters (already cast to float8). */
export const haversineSql = (latCol, lngCol, latParam, lngParam) =>
  `(2 * ${EARTH_RADIUS_KM} * asin(sqrt(least(1.0, ` +
  `power(sin(radians(${latCol} - ${latParam}) / 2), 2) + ` +
  `cos(radians(${latParam})) * cos(radians(${latCol})) * power(sin(radians(${lngCol} - ${lngParam}) / 2), 2)))))`;
