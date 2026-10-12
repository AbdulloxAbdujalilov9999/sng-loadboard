import { z } from 'zod';
import { distanceKm, fold, resolveCity } from '../lib/ai/cities.js';
import { HttpError } from '../lib/errors.js';

const EQUIP = ['T', 'R', 'F', 'V', 'AC'];
const MAX_ITEMS = 50;
const DEFAULT_WEIGHT_T = 20; // a full tent/"fura" truck; flagged in the response so the member checks it

const bodySchema = z.object({ text: z.string().trim().min(8, 'Paste at least one post').max(12_000) }).strict();

// What we accept back from the model. Loose on purpose: ONE odd field (a string where a number belongs, "yes" for a
// boolean) is dropped on its own - it must never throw away a whole pasted batch. Real validation happens below.
const soft = (schema) => schema.nullish().catch(undefined);
const placeSchema = z.object({
  text: z.string().catch(''),
  city: soft(z.string()),
  country: soft(z.string()),
  region: soft(z.string()),
  lat: soft(z.number()),
  lng: soft(z.number()),
  cityLabel: soft(z.string()), // older prompt format: a label picked from our list (still verified)
}).passthrough().catch({ text: '' });

const loadsRaw = z.object({
  loads: z.array(z.object({
    origin: placeSchema,
    destinations: z.array(placeSchema).catch([]),
    equipment: z.array(z.string()).catch([]),
    fullOrPartial: soft(z.string()),
    weightT: soft(z.number()),
    volumeM3: soft(z.number()),
    pickupDate: soft(z.string()),
    rateUsd: soft(z.number()),
    commodity: z.string().catch(''),
    notes: z.string().catch(''),
    phone: soft(z.string()),
    telegram: soft(z.string()),
    contactName: soft(z.string()),
  }).passthrough()).catch([]),
}).passthrough();

const trucksRaw = z.object({
  trucks: z.array(z.object({
    location: placeSchema,
    destinationText: soft(z.string()),
    equipment: z.array(z.string()).catch([]),
    capacityT: soft(z.number()),
    volumeM3: soft(z.number()),
    availableFrom: soft(z.string()),
    availableTo: soft(z.string()),
    minRateUsd: soft(z.number()),
    hasTir: soft(z.boolean()),
    hasAdr: soft(z.boolean()),
    hasGps: soft(z.boolean()),
    sideLoading: soft(z.boolean()),
    notes: z.string().catch(''),
    phone: soft(z.string()),
    telegram: soft(z.string()),
    contactName: soft(z.string()),
  }).passthrough()).catch([]),
}).passthrough();

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : null);
const positive = (n, max) => (Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 100) / 100 : null);

const RANK = { label: 0, exact: 1, region: 2, fuzzy: 3, nearest: 4 };

/**
 * Turn what the model said about ONE place into a city on our board. Tries the model's own "city" first, then the
 * text as written (and its region); an exact name beats a region beats a fuzzy match beats "nearest town".
 * `check` = true when the match is only approximate, so the member is asked to verify it.
 */
function resolvePlace(index, place) {
  const cc = /^[A-Za-z]{2}$/.test(place.country ?? '') ? place.country.toUpperCase() : null;
  const coords = { lat: place.lat ?? undefined, lng: place.lng ?? undefined };
  const attempts = [];
  if (place.cityLabel) attempts.push(resolveCity(index, { label: place.cityLabel }));
  for (const text of [place.city, place.text, place.region].filter(Boolean)) attempts.push(resolveCity(index, { text, country: cc }));
  attempts.push(resolveCity(index, { text: place.city || place.text, country: cc, ...coords })); // adds the coordinate fallback
  const found = attempts.filter((a) => a.city);
  if (!found.length) return { city: null, how: null, check: false };

  // Two different EXACT town matches (e.g. the model said "Tomsk" but the text says "ТОМСК АСИНО"): the smaller, more
  // specific town wins when it lies in the same region.
  const exact = found.filter((a) => a.how === 'exact' || a.how === 'label');
  const distinct = [...new Map(exact.map((a) => [a.city.id, a])).values()];
  if (distinct.length > 1) {
    const small = distinct.sort((a, b) => (a.city.population ?? 0) - (b.city.population ?? 0))[0];
    const big = distinct[distinct.length - 1];
    if (distanceKm(small.city, big.city) < 400) return { city: small.city, how: 'exact', check: false };
  }
  const best = found.sort((a, b) => RANK[a.how] - RANK[b.how])[0];
  return { city: best.city, how: best.how, check: RANK[best.how] >= RANK.fuzzy };
}

const sameName = (index, city, text) => {
  const entry = index.entryOf.get(city.id);
  const t = String(text ?? '').trim();
  return !t || !entry || entry.keys.includes(fold(t));
};

export default async function aiRoutes(app, { config, ai }) {
  // Soft per-member budget (per instance) + a cap on parallel model calls, so one person cannot burn the API quota.
  const used = new Map();
  let inFlight = 0;
  const budget = (req) => {
    if (req.member?.role === 'owner') return; // the platform owner is never limited
    const email = req.user.email;
    const now = Date.now();
    const hits = (used.get(email) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= config.aiRatePerHour) {
      const min = Math.max(1, Math.ceil((hits[0] + 3_600_000 - now) / 60_000)); // when the oldest read leaves the hour
      throw new HttpError(429, 'ai_limit', `AI import limit reached (${config.aiRatePerHour} per hour). Try again in ${min} min.`, [{ path: 'ai', code: 'ai_limit', params: { n: config.aiRatePerHour, min } }]);
    }
    hits.push(now);
    used.set(email, hits);
    if (used.size > 5000) for (const [k, v] of used) if (!v.some((t) => now - t < 3_600_000)) used.delete(k);
  };

  /** Shared plumbing: auth/budget/limits, call the parser, validate the raw shape. */
  async function run(req, method, schema, key) {
    if (!ai || typeof ai[method] !== 'function') throw new HttpError(503, 'ai_unavailable', 'AI import is not set up on this server yet.');
    const { text } = bodySchema.parse(req.body);
    budget(req);
    if (inFlight >= config.aiMaxParallel) throw new HttpError(503, 'ai_busy', 'The AI is busy right now. Please try again in a moment.');
    const index = await app.cityIndex();
    const today = new Date().toISOString().slice(0, 10);
    let raw;
    inFlight += 1;
    try {
      raw = await ai[method]({ text, cities: index.cities, today });
    } catch (err) {
      if (err.logDetail) req.log.error({ ai: ai.name, detail: err.logDetail }, 'AI provider error');
      throw err;
    } finally { inFlight -= 1; }
    req.log.info({ ai: ai.name, chars: text.length, kind: key }, 'ai parse'); // never log the pasted text itself
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new HttpError(502, 'ai_bad_output', 'The AI answered in an unexpected format. Please try again.');
    return { index, today, items: parsed.data[key] };
  }

  // ------------------------------------------------------------------ loads
  app.post('/api/ai/parse-loads', { preHandler: app.guards.active }, async (req) => {
    const { index, today, items } = await run(req, 'parseLoads', loadsRaw, 'loads');
    const drafts = items.slice(0, MAX_ITEMS).map((r) => {
      const flags = [];
      const origin = resolvePlace(index, r.origin);
      const dests = r.destinations.map((d) => ({ ...d, res: resolvePlace(index, d) }));
      const firstDest = dests.find((d) => d.res.city) ?? dests[0];
      const extraDests = dests.filter((d) => d !== firstDest);

      if (!origin.city) flags.push('origin'); else if (origin.check) flags.push('origin_check');
      if (!firstDest?.res.city) flags.push('dest'); else if (firstDest.res.check) flags.push('dest_check');
      if (origin.city && origin.city.id === firstDest?.res.city?.id) flags.push('same_city');

      const equipment = [...new Set(r.equipment.map((e) => String(e).toUpperCase()).filter((e) => EQUIP.includes(e)))];
      const weight = positive(r.weightT, 100);
      const date = isoDate(r.pickupDate);
      const rate = Number.isFinite(r.rateUsd) && r.rateUsd > 0 ? Math.round(r.rateUsd * 100) / 100 : null;
      if (weight === null) flags.push('weight');
      if (date === null || date < today) flags.push('date');
      if (rate === null) flags.push('rate');

      // Anything that did not become a structured field is kept in the notes so no information is lost.
      const noteParts = [];
      if (r.notes) noteParts.push(clip(r.notes, 300));
      if (origin.city && r.origin.text && !sameName(index, origin.city, r.origin.text)) noteParts.push(`PU: ${clip(r.origin.text, 60)}`);
      if (firstDest?.res.city && firstDest.text && !sameName(index, firstDest.res.city, firstDest.text)) noteParts.push(`DEL: ${clip(firstDest.text, 60)}`);
      if (extraDests.length) noteParts.push(`Also DEL: ${extraDests.map((d) => clip(d.res.city?.label ?? d.text, 40)).join(', ')}`);
      if (equipment.length > 1) noteParts.push(`Also: ${equipment.slice(1).join('/')}`);

      return {
        originCityId: origin.city?.id ?? null,
        originCity: origin.city?.label ?? null,
        originText: clip(r.origin.text || r.origin.city, 80),
        destCityId: firstDest?.res.city?.id ?? null,
        destCity: firstDest?.res.city?.label ?? null,
        destText: clip(firstDest?.text || firstDest?.city, 80),
        equip: equipment[0] ?? 'T',
        fp: r.fullOrPartial === 'Partial' ? 'Partial' : 'Full',
        weightT: weight ?? DEFAULT_WEIGHT_T,
        volumeM3: Number.isFinite(r.volumeM3) && r.volumeM3 >= 1 && r.volumeM3 <= 200 ? Math.round(r.volumeM3) : null,
        pickupDate: date && date >= today ? date : today,
        rateUsd: rate ?? 0,
        commodity: clip(r.commodity, 200) || 'General cargo',
        notes: clip(noteParts.join(' · '), 500),
        contactPhone: clip(r.phone, 40),
        contactTelegram: clip(r.telegram, 40),
        contactName: clip(r.contactName, 120),
        flags,
      };
    });
    return { loads: drafts, truncated: items.length > MAX_ITEMS };
  });

  // ------------------------------------------------------------------ trucks
  app.post('/api/ai/parse-trucks', { preHandler: app.guards.active }, async (req) => {
    const { index, today, items } = await run(req, 'parseTrucks', trucksRaw, 'trucks');
    const drafts = items.slice(0, MAX_ITEMS).map((r) => {
      const flags = [];
      const loc = resolvePlace(index, r.location);
      if (!loc.city) flags.push('location'); else if (loc.check) flags.push('location_check');

      const equipment = [...new Set(r.equipment.map((e) => String(e).toUpperCase()).filter((e) => EQUIP.includes(e)))];
      const capacity = positive(r.capacityT, 100);
      const volume = Number.isFinite(r.volumeM3) && r.volumeM3 >= 1 && r.volumeM3 <= 200 ? Math.round(r.volumeM3) : null;
      let from = isoDate(r.availableFrom);
      if (!from || from < today) { flags.push('date'); from = today; }
      let to = isoDate(r.availableTo);
      if (to && to < from) to = null;
      if (capacity === null) flags.push('capacity');

      const noteParts = [];
      if (r.notes) noteParts.push(clip(r.notes, 300));
      if (loc.city && r.location.text && !sameName(index, loc.city, r.location.text)) noteParts.push(`At: ${clip(r.location.text, 60)}`);
      if (equipment.length > 1) noteParts.push(`Also: ${equipment.slice(1).join('/')}`);

      return {
        locCityId: loc.city?.id ?? null,
        locCity: loc.city?.label ?? null,
        locText: clip(r.location.text || r.location.city, 80),
        destPref: clip(r.destinationText, 120) || 'Anywhere',
        equip: equipment[0] ?? 'T',
        capacityT: capacity ?? DEFAULT_WEIGHT_T,
        volumeM3: volume,
        availableFrom: from,
        availableTo: to,
        minRateUsd: Number.isFinite(r.minRateUsd) && r.minRateUsd > 0 ? Math.round(r.minRateUsd * 100) / 100 : null,
        hasTir: Boolean(r.hasTir), hasAdr: Boolean(r.hasAdr), hasGps: Boolean(r.hasGps), sideLoading: Boolean(r.sideLoading),
        notes: clip(noteParts.join(' · '), 500),
        contactPhone: clip(r.phone, 40),
        contactTelegram: clip(r.telegram, 40),
        flags,
      };
    });
    return { trucks: drafts, truncated: items.length > MAX_ITEMS };
  });
}
