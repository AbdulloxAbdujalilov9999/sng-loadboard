import { z } from 'zod';

export const EQUIP = ['T', 'R', 'F', 'V', 'AC'];
export const FP = ['Full', 'Partial'];

const trimmed = (max, min = 1) => z.string().trim().min(min).max(max);
const optionalText = (max) => z.string().trim().max(max).default('');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_format').refine((d) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}, 'date_real');

const phone = z.string().trim().regex(/^[0-9+()\-.\s]{6,40}$/, 'phone');
const telegram = z.string().trim().regex(/^@?[A-Za-z0-9_]{4,32}$/, 'telegram')
  .transform((v) => (v.startsWith('@') ? v : `@${v}`));
const email = z.string().trim().toLowerCase().email().max(254);

export const accessRequestBody = z.object({
  company: trimmed(120),
  phone,
  telegram,
  contactName: optionalText(120),
}).strict();

// A profile may leave contact fields empty (they are only REQUIRED when posting), so "default contact info"
// can be saved a piece at a time. An empty string clears the field.
const orEmpty = (schema) => z.union([z.literal(''), schema]);
export const profileBody = z.object({
  company: trimmed(120),
  contactName: optionalText(120),
  phone: orEmpty(phone),
  telegram: orEmpty(telegram),
  contactEmail: z.union([z.literal(''), email]),
  location: optionalText(120),
  tirCarnet: optionalText(60),
  fleet: optionalText(200),
  routes: optionalText(300),
}).partial().strict();

const cityId = z.coerce.number().int().positive();
const money = z.coerce.number().min(0).max(10_000_000).transform((n) => Math.round(n * 100) / 100);

export const loadBody = z.object({
  originCityId: cityId,
  destCityId: cityId,
  equip: z.enum(EQUIP),
  fp: z.enum(FP),
  weightT: z.coerce.number().gt(0).max(100).transform((n) => Math.round(n * 100) / 100),
  volumeM3: z.coerce.number().int().min(1).max(200).nullish().transform((v) => v ?? null),
  pickupDate: isoDate,
  deliveryDate: isoDate.nullish().transform((v) => v ?? null),
  rateUsd: money,
  commodity: trimmed(200),
  notes: z.string().trim().max(500).optional(), // optional (no default) so PATCH never wipes it by accident
  contactName: trimmed(120),
  contactPhone: phone,
  contactEmail: email,
  contactTelegram: telegram,
}).strict();

export const loadsBulkBody = z.object({ loads: z.array(loadBody).min(1).max(40) }).strict();

export const loadPatchBody = loadBody.partial().strict();

export const truckBody = z.object({
  locCityId: cityId,
  destPref: z.string().trim().max(120).default('Anywhere').transform((v) => v || 'Anywhere'),
  equip: z.enum(EQUIP),
  capacityT: z.coerce.number().gt(0).max(100).transform((n) => Math.round(n * 100) / 100),
  volumeM3: z.coerce.number().int().min(1).max(200).nullish().transform((v) => v ?? null),
  availableFrom: isoDate,
  availableTo: isoDate.nullish().transform((v) => v ?? null),
  minRateUsd: money.nullish().transform((v) => v ?? null),
  hasTir: z.boolean().default(false),
  hasAdr: z.boolean().default(false),
  hasGps: z.boolean().default(false),
  sideLoading: z.boolean().default(false),
  contactPhone: phone,
  contactTelegram: telegram,
}).strict();

const csv = (allowed) => z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.enum(allowed)).max(allowed.length));
const limit = (def, max) => z.coerce.number().int().min(1).max(max).default(def);
const dir = z.enum(['asc', 'desc']);

export const LOAD_SORTS = ['created', 'pickup', 'origin', 'dest', 'equip', 'weight', 'distance', 'rate', 'company'];
export const loadQuery = z.object({
  origin: cityId.optional(),
  originRadius: z.coerce.number().int().min(0).max(2000).default(100),
  dest: cityId.optional(),
  destRadius: z.coerce.number().int().min(0).max(2000).default(100),
  equip: csv(EQUIP).optional(),
  fp: z.enum(FP).optional(),
  dateFrom: isoDate.optional(),
  dateTo: isoDate.optional(),
  minWeight: z.coerce.number().min(0).max(100).optional(),
  maxWeight: z.coerce.number().min(0).max(100).optional(),
  minRate: z.coerce.number().min(0).optional(),
  maxDistance: z.coerce.number().int().min(1).max(25000).optional(),
  q: z.string().trim().min(2).max(60).optional(), // trigram index needs >= 2 chars
  sort: z.enum(LOAD_SORTS).default('created'),
  dir: dir.default('desc'),
  limit: limit(50, 100),
  cursor: z.string().max(300).optional(),
}).strict();

export const TRUCK_SORTS = ['created', 'available', 'loc', 'equip', 'capacity', 'rate'];
export const truckQuery = z.object({
  loc: cityId.optional(),
  locRadius: z.coerce.number().int().min(0).max(2000).default(150),
  dest: z.string().trim().max(60).optional(),
  equip: csv(EQUIP).optional(),
  availableOn: isoDate.optional(),
  minCapacity: z.coerce.number().min(0).max(100).optional(),
  sort: z.enum(TRUCK_SORTS).default('created'),
  dir: dir.default('desc'),
  limit: limit(50, 100),
  cursor: z.string().max(300).optional(),
}).strict();

export const directoryQuery = z.object({
  q: z.string().trim().max(60).optional(),
  limit: limit(60, 100),
  cursor: z.string().max(300).optional(),
}).strict();

export const citiesQuery = z.object({
  q: z.string().trim().max(60).default(''),
  limit: limit(8, 25),
}).strict();

export const adminMembersQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
}).strict();

export const fxBody = z.object({
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.coerce.number().positive().max(1e9)),
}).strict();

export const idParam = z.object({ id: z.coerce.number().int().positive() }).strict();
