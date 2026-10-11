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

// Contact rule used everywhere: a phone number OR a Telegram username is required, the other one is optional
// (e-mail is always optional). Reports on both fields so the form can highlight them.
const needsContact = (v, ctx, phoneKey = 'contactPhone', tgKey = 'contactTelegram') => {
  if (!v[phoneKey] && !v[tgKey]) {
    for (const path of [phoneKey, tgKey]) ctx.addIssue({ code: 'custom', path: [path], message: 'contact_required' });
  }
};

const orEmpty = (schema) => z.union([z.literal(''), schema]);
const pin = z.string().regex(/^\d{4,6}$/, 'pin_format');

// Signing up: a name and one way to be reached. Company is optional (added later in Settings; the name stands in until then).
export const signupBody = z.object({
  contactName: trimmed(120),
  company: optionalText(120),
  phone: orEmpty(phone).default(''),
  telegram: orEmpty(telegram).default(''),
  contactEmail: orEmpty(email).default(''),
  pin: pin.optional(),
}).strict();
export const accessRequestBody = signupBody; // the endpoint keeps its old URL

export const pinBody = z.object({ pin, currentPin: pin.optional() }).strict();
export const pinLoginBody = z.object({
  phone: z.string().trim().regex(/^\+\d{8,15}$/, 'phone'),
  pin,
  purpose: z.enum(['web', 'bot']).default('web'),
}).strict();
const e164 = z.string().trim().regex(/^\+\d{8,15}$/, 'phone');
export const loginPhoneBody = z.object({ phone: e164, pin }).strict();
// Phone sign-up without SMS: a number, a 4-6 digit password and the person's name; the number itself is the contact.
export const phoneRegisterBody = z.object({
  phone: e164,
  pin,
  contactName: trimmed(120),
  company: optionalText(120),
  telegram: orEmpty(telegram).default(''),
  contactEmail: orEmpty(email).default(''),
}).strict();
export const phoneCheckBody = z.object({ phone: z.string().trim().regex(/^\+\d{8,15}$/, 'phone') }).strict();

// A profile may leave contact fields empty while it is being filled in; an empty string clears a field.
// (The route checks that a phone or Telegram username is always left.)
export const profileBody = z.object({
  company: z.string().trim().max(120),      // '' = "no company": the name is shown instead
  worksWithCompany: z.boolean(),            // false = an individual: the company shown is simply their own name
  contactName: z.string().trim().max(120),
  phone: z.union([z.literal(''), phone]),
  telegram: z.union([z.literal(''), telegram]),
  contactEmail: z.union([z.literal(''), email]),
  location: z.string().trim().max(120),
  tirCarnet: z.string().trim().max(60),
  fleet: z.string().trim().max(200),
  routes: z.string().trim().max(300),
}).partial().strict();

const cityId = z.coerce.number().int().positive();
const money = z.coerce.number().min(0).max(10_000_000).transform((n) => Math.round(n * 100) / 100);

const loadBase = z.object({
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
  contactPhone: orEmpty(phone),
  contactEmail: orEmpty(email),
  contactTelegram: orEmpty(telegram),
}).strict();
// Creating: contacts may be left out (they become ''). Editing (below) never applies defaults, so omitted fields stay as they are.
export const loadBody = loadBase.extend({
  contactPhone: orEmpty(phone).default(''),
  contactEmail: orEmpty(email).default(''),
  contactTelegram: orEmpty(telegram).default(''),
}).superRefine((v, ctx) => needsContact(v, ctx));

export const loadsBulkBody = z.object({ loads: z.array(loadBody).min(1).max(40) }).strict();

export const loadPatchBody = loadBase.partial().strict(); // the route checks the merged result still has a phone or Telegram

const truckBase = z.object({
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
  notes: z.string().trim().max(500).optional(), // optional (no default), like loads
  contactPhone: orEmpty(phone),
  contactTelegram: orEmpty(telegram),
}).strict();
export const truckBody = truckBase.extend({
  contactPhone: orEmpty(phone).default(''),
  contactTelegram: orEmpty(telegram).default(''),
}).superRefine((v, ctx) => needsContact(v, ctx));

export const trucksBulkBody = z.object({ trucks: z.array(truckBody).min(1).max(40) }).strict();

const csv = (allowed) => z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.enum(allowed)).max(allowed.length));
const limit = (def, max) => z.coerce.number().int().min(1).max(max).default(def);
const dir = z.enum(['asc', 'desc']);

export const LOAD_SORTS = ['created', 'pickup', 'origin', 'dest', 'equip', 'weight', 'distance', 'rate', 'company'];
const cc = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'invalid');
export const loadQuery = z.object({
  origin: cityId.optional(),
  originRadius: z.coerce.number().int().min(0).max(2000).default(100),
  dest: cityId.optional(),
  originCountry: cc.optional(), // a whole country as origin / destination ("UZ -> KZ")
  destCountry: cc.optional(),
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
  locCountry: cc.optional(),
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
  countries: z.enum(['0', '1']).default('0'), // 1 = also offer whole countries (search filters, not posting forms)
}).strict();

export const adminMembersQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).default('all'),
}).strict();

export const fxBody = z.object({
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.coerce.number().positive().max(1e9)),
}).strict();

export const idParam = z.object({ id: z.coerce.number().int().positive() }).strict();
