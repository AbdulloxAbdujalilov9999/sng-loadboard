// Row -> API shape mappers. Keeping these in one place means the wire format is explicit and a new
// DB column never leaks to clients by accident.
import { loginLabel, publicEmail, realEmail } from './identity.js';
const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
// List queries return created_at as epoch-ms (cheap to decode); single-row queries return a Date.
const createdIso = (r) => (r.created_ms !== undefined ? new Date(Number(r.created_ms)).toISOString() : iso(r.created_at));

export const memberDto = (m) => ({
  id: m.id,
  email: realEmail(m.email),
  login: loginLabel(m.email),
  company: m.company,
  contactName: m.contact_name,
  phone: m.phone,
  telegram: m.telegram,
  contactEmail: m.contact_email ?? '',
  location: m.location,
  tirCarnet: m.tir_carnet,
  fleet: m.fleet,
  routes: m.routes,
  status: m.status,
  role: m.role,
  requestedAt: iso(m.requested_at),
  reviewedAt: iso(m.reviewed_at),
});

export const directoryDto = (m) => ({
  id: m.id,
  company: m.company,
  contactName: m.contact_name,
  phone: m.phone,
  email: publicEmail(m.email, m.contact_email),
  telegram: m.telegram,
  location: m.location,
  tirCarnet: m.tir_carnet,
  fleet: m.fleet,
  routes: m.routes,
});

export const loadDto = (r, viewerId) => ({
  id: r.id,
  createdAt: createdIso(r),
  originCityId: r.origin_city_id,
  originCity: r.origin_city,
  destCityId: r.dest_city_id,
  destCity: r.dest_city,
  equip: r.equip,
  fp: r.fp,
  weightT: num(r.weight_t),
  volumeM3: r.volume_m3,
  pickupDate: r.pickup_date,
  deliveryDate: r.delivery_date,
  distanceKm: r.distance_km,
  rateUsd: num(r.rate_usd),
  commodity: r.commodity,
  notes: r.notes ?? '',
  company: r.company_name,
  contactName: r.contact_name,
  contactPhone: r.contact_phone,
  contactEmail: r.contact_email,
  contactTelegram: r.contact_tg,
  dho: r.dho ?? null,
  dhd: r.dhd ?? null,
  mine: r.owner_id === viewerId,
});

export const truckDto = (r, viewerId) => ({
  id: r.id,
  createdAt: createdIso(r),
  locCityId: r.loc_city_id,
  locCity: r.loc_city,
  destPref: r.dest_pref,
  equip: r.equip,
  capacityT: num(r.capacity_t),
  volumeM3: r.volume_m3,
  availableFrom: r.available_from,
  availableTo: r.available_to,
  minRateUsd: num(r.min_rate_usd),
  hasTir: r.has_tir,
  hasAdr: r.has_adr,
  hasGps: r.has_gps,
  sideLoading: r.side_loading,
  company: r.company_name,
  contactPhone: r.contact_phone,
  contactTelegram: r.contact_tg,
  dho: r.dho ?? null,
  mine: r.owner_id === viewerId,
});

export const cityDto = (c) => ({ id: c.id, name: c.name, nameRu: c.name_ru, country: c.country.trim(), label: c.label, lat: c.lat, lng: c.lng });

/** Escape % _ \ so user text can't act as LIKE wildcards. */
export const likePattern = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
