import { z } from 'zod';
import { fold, resolveCity } from '../lib/ai/cities.js';
import { HttpError, tooMany } from '../lib/errors.js';

const EQUIP = ['T', 'R', 'F', 'V', 'AC'];
const MAX_LOADS = 40;
const DEFAULT_WEIGHT_T = 20; // a full tent/"fura" truck; flagged in the response so the member checks it

const bodySchema = z.object({ text: z.string().trim().min(8, 'Paste at least one load').max(12_000) }).strict();

// What we accept back from the model. Loose on purpose: we repair/verify below instead of trusting it.
const rawSchema = z.object({
  loads: z.array(z.object({
    origin: z.object({ place: z.string().default(''), cityLabel: z.string().nullish() }),
    destinations: z.array(z.object({ place: z.string().default(''), cityLabel: z.string().nullish() })).default([]),
    equipment: z.array(z.string()).default([]),
    fullOrPartial: z.string().nullish(),
    weightT: z.number().nullish(),
    pickupDate: z.string().nullish(),
    rateUsd: z.number().nullish(),
    commodity: z.string().default(''),
    notes: z.string().default(''),
    phone: z.string().nullish(),
    telegram: z.string().nullish(),
    contactName: z.string().nullish(),
  }).passthrough()).default([]),
}).passthrough();

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s ? s : null);

export default async function aiRoutes(app, { config, ai }) {
  // Soft per-member budget (per instance) + a cap on parallel model calls, so one person cannot burn the API quota.
  const used = new Map();
  let inFlight = 0;
  const budget = (email) => {
    const now = Date.now();
    const hits = (used.get(email) ?? []).filter((t) => now - t < 3_600_000);
    if (hits.length >= config.aiRatePerHour) throw tooMany(`AI import limit reached (${config.aiRatePerHour} per hour). Try again later.`);
    hits.push(now);
    used.set(email, hits);
    if (used.size > 5000) for (const [k, v] of used) if (!v.some((t) => now - t < 3_600_000)) used.delete(k);
  };

  app.post('/api/ai/parse-loads', { preHandler: app.guards.approved }, async (req) => {
    if (!ai) throw new HttpError(503, 'ai_unavailable', 'AI import is not set up on this server yet.');
    const { text } = bodySchema.parse(req.body);
    budget(req.user.email);
    if (inFlight >= config.aiMaxParallel) throw new HttpError(503, 'ai_busy', 'The AI is busy right now. Please try again in a moment.');

    const index = await app.cityIndex();
    const today = new Date().toISOString().slice(0, 10);
    let raw;
    inFlight += 1;
    try {
      raw = await ai.parseLoads({ text, cities: index.cities, today });
    } catch (err) {
      if (err.logDetail) req.log.error({ ai: ai.name, detail: err.logDetail }, 'AI provider error');
      throw err;
    } finally { inFlight -= 1; }
    req.log.info({ ai: ai.name, chars: text.length }, 'ai parse'); // never log the pasted text itself

    const parsed = rawSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(502, 'ai_bad_output', 'The AI answered in an unexpected format. Please try again.');

    const drafts = parsed.data.loads.slice(0, MAX_LOADS).map((r) => {
      const flags = [];
      const originRes = resolveCity(index, { label: r.origin.cityLabel, text: r.origin.place });
      const dests = r.destinations.map((d) => ({ ...d, res: resolveCity(index, { label: d.cityLabel, text: d.place }) }));
      const firstDest = dests.find((d) => d.res.city) ?? dests[0];
      const extraDests = dests.filter((d) => d !== firstDest);

      if (!originRes.city) flags.push('origin');
      if (!firstDest?.res.city) flags.push('dest');
      if (originRes.city && originRes.city.id === firstDest?.res.city?.id) flags.push('same_city');

      const equipment = [...new Set(r.equipment.map((e) => String(e).toUpperCase()).filter((e) => EQUIP.includes(e)))];
      const weight = Number.isFinite(r.weightT) && r.weightT > 0 && r.weightT <= 100 ? Math.round(r.weightT * 100) / 100 : null;
      const date = isoDate(r.pickupDate);
      const rate = Number.isFinite(r.rateUsd) && r.rateUsd > 0 ? Math.round(r.rateUsd * 100) / 100 : null;
      if (weight === null) flags.push('weight');
      if (date === null) flags.push('date');
      if (rate === null) flags.push('rate');

      // Anything that did not become a structured field is kept in the notes so no information is lost.
      const noteParts = [];
      if (r.notes) noteParts.push(clip(r.notes, 300));
      if (originRes.city && r.origin.place && !sameName(originRes.city, r.origin.place)) noteParts.push(`PU: ${clip(r.origin.place, 60)}`);
      if (firstDest?.res.city && firstDest.place && !sameName(firstDest.res.city, firstDest.place)) noteParts.push(`DEL: ${clip(firstDest.place, 60)}`);
      if (extraDests.length) noteParts.push(`Also DEL: ${extraDests.map((d) => clip(d.res.city?.label ?? d.place, 40)).join(', ')}`);
      if (equipment.length > 1) noteParts.push(`Also: ${equipment.slice(1).join('/')}`);

      return {
        originCityId: originRes.city?.id ?? null,
        originCity: originRes.city?.label ?? null,
        originText: clip(r.origin.place, 80),
        destCityId: firstDest?.res.city?.id ?? null,
        destCity: firstDest?.res.city?.label ?? null,
        destText: clip(firstDest?.place, 80),
        equip: equipment[0] ?? 'T',
        fp: r.fullOrPartial === 'Partial' ? 'Partial' : 'Full',
        weightT: weight ?? DEFAULT_WEIGHT_T,
        pickupDate: date ?? today,
        rateUsd: rate ?? 0,
        commodity: clip(r.commodity, 200) || 'General cargo',
        notes: clip(noteParts.join(' · '), 500),
        contactPhone: clip(r.phone, 40),
        contactTelegram: clip(r.telegram, 40),
        contactName: clip(r.contactName, 120),
        flags,
      };
    });
    return { loads: drafts, truncated: parsed.data.loads.length > MAX_LOADS };
  });
}

// "Томск" is the same place as Tomsk/Томск: no need to repeat it in the notes.
function sameName(city, text) {
  const t = fold(text);
  return t === fold(city.name) || t === fold(city.name_ru);
}
