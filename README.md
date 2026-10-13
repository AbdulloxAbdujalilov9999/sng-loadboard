<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-lockup-dark.png">
    <img src="brand/logo-lockup-light.png" alt="SNG ONE — Yuk birjasi" width="480">
  </picture>
</p>

# SNG ONE — freight marketplace for the CIS / Eurasia

Load board, truck board and carrier directory with open sign-up (the owner is notified and can block anyone).
Node 22 + Fastify API · PostgreSQL · Firebase Google sign-in · vanilla-JS web app served by the same process.

```
browser ──HTTPS──▶ Fastify (N workers) ──▶ PostgreSQL
   │   ▲                │                      ▲
   │   └── SSE live ────┴── LISTEN/NOTIFY ─────┘
   └── Google sign-in (Firebase Auth) → ID token → verified by the API on every request
```

## What it does

- **Sign in your way**: **phone number + a 4-6 digit password first** (always the default tab; no SMS), or Google, or email + password (with email confirmation, *forgot password* and *change password*). A Google / e-mail member can add a phone number + password in Settings and then sign in either way: it is the same account. Uzbek is the default language.
- **Three languages** (English, Русский, O‘zbekcha) and **light / dark / auto** appearance, switchable from the sign-in screen, the header, and Account → Preferences.
- **Open sign-up.** A name plus a phone number *or* a Telegram username is all it takes; new members can use the platform at once. The owner gets a live notification (and a Telegram message if their account is linked to the bot) for every new member, and can block, unblock or remove anyone on the Members page. Company and e-mail are optional and can be added in Settings.
- **Loads**: post, edit, close; search by origin/destination **with deadhead radius**, equipment, dates, weight, rate, distance, free text; sort by any column; infinite scroll.
- **AI paste import**: paste one or many Telegram/WhatsApp posts (Russian Cyrillic or Uzbek Latin/Cyrillic); Gemini splits them into separate loads and fills cities, cargo, truck type and notes; the member reviews and posts them all in one click. Details below.
- **Default contact info** in Account: pre-fills the contact fields of every new load and truck (still editable per post).
- **Trucks**: post availability with end date (auto-expires after 30 days without one); same radius/equipment/date search.
- **Contact rule everywhere** (sign-up, profile, loads, trucks, AI import, Telegram bot): a phone number **or** a Telegram username is required (either one), e-mail is always optional.
- **Carrier directory** of members; **display currencies** (USD, RUB, KZT, UZS, KGS, TJS, BYN, AZN, GEL, AMD) with owner-editable rates; **English / Russian** UI; mobile layout.
- **Live updates**: new posts, approvals and rate changes reach open browsers within a second (Server-Sent Events, backed by Postgres `LISTEN/NOTIFY`).

Community: Telegram [@sngOne_yuklar](https://t.me/sngOne_yuklar) and [@sngOne_yuklarr](https://t.me/sngOne_yuklarr) (linked from the sign-in screen and the sidebar).

## Run it locally (no accounts needed)

```bash
npm install
npm run dev:fake-auth -- --seed 20000     # embedded Postgres in .dev-db, fake sign-in, 20k demo loads
# open http://localhost:8080 — sign in as owner@dev.local, or any other email
```

Fake sign-in exists **only** in this dev server and is refused when `NODE_ENV=production`.

## Run it for real

```bash
cp .env.example .env     # set DATABASE_URL and OWNER_EMAILS
npm ci && npm run build:web
npm start                # runs migrations, then serves API + web on :8080
```

or with Docker (Postgres + API): `OWNER_EMAILS=you@gmail.com docker compose up --build`.

### Deploying (Render, ~10 minutes)

This is a Node server plus PostgreSQL, so it cannot run on static hosts (Vercel/Netlify/GitHub Pages show a 404). Render hosts both:

1. Push this repository to GitHub, then on <https://render.com>: **New + → Blueprint** → select the repo. It reads [`render.yaml`](render.yaml) and creates the database and the web service.
2. When asked, enter `OWNER_EMAILS` (your Google email) and `GEMINI_API_KEY`.
3. After the first deploy, open the service URL — the page loads, but Google sign-in will say the domain is not authorized until you do step 4.
4. In the Firebase console (project `sng-pro`) → **Authentication → Settings → Authorized domains → Add** your `*.onrender.com` address (and your own domain later). Also make sure **Google** is enabled under Sign-in method.
5. Sign in with the owner email: you are the owner and are told about every new member. Any other host that can run a Docker container (Railway, Fly.io, a VPS) works the same way; use the `Dockerfile` and the variables in `.env.example`.

### Sign-in methods: what to switch on in Firebase

In the [Firebase console](https://console.firebase.google.com) → project `sng-pro` → **Authentication → Sign-in method**:

| Method | Switch on | Notes |
| --- | --- | --- |
| Google | **Google** provider | already on |
| Email + password | **Email/Password** provider | people must confirm their email before the platform lets them in (otherwise anyone could register the owner's address) |

Also under **Authentication → Settings → Authorized domains** add your site's domain (e.g. `your-app.onrender.com`), and under **Templates** you can edit the wording and sender name of the *Password reset* and *Email verification* messages (Firebase sends them in the visitor's language).

**Phone + password (no SMS, no Firebase).** `POST /api/auth/phone/register` creates an account from a phone number, a name and a 4-6 digit password; `POST /api/auth/pin/login` signs in; the server issues its own session token (`AUTH_SECRET`, at least 16 characters; `deploy/update.sh` generates one). Because nothing proves the person owns the number, the safety comes from elsewhere: the password is stored only as a salted scrypt hash, 5 wrong tries lock that number for 15 minutes, sign-in and sign-up are rate-limited per IP, any 4-6 digit password is allowed (even 1111 or 1234: a product decision), changing the password ends all other sessions, and the owner (a verified e-mail) can never sign in with a password. **Forgot password:** the owner opens Members → *Reset password*, which creates a new random 6-digit password shown once, to pass on to the member. Without `AUTH_SECRET` the feature is off. The Firebase *Phone* provider is not used.

How identities work: Google and email accounts are identified by their verified email; phone accounts by the phone number (stored internally as `p<digits>@phone.sng`, never shown). The owner is only ever matched on a verified email in `OWNER_EMAILS`.

Password reset: Firebase emails a secure single-use link (not a typed code); the person opens it, chooses a new password, and signs in. Signed-in users can also change their password in Account → Sign-in & Security.

### One-time Firebase setup
In the Firebase console for project `sng-pro` (Authentication):
1. **Sign-in method** → enable **Google**.
2. **Settings → Authorized domains** → add your production domain (and `localhost` for dev).
3. The web config in `web/js/config.js` is public by design; the API trusts only tokens signed for this project.

The owner is whoever signs in with an email listed in `OWNER_EMAILS` — there is no stored owner password.

### Environment
See [`.env.example`](.env.example) for every variable. The important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 14+, **UTF-8 database** (required) |
| `OWNER_EMAILS` | comma-separated owner Google emails (required in production) |
| `DATABASE_SSL` | `true` for managed databases that require TLS |
| `TRUST_PROXY` | `true` behind a load balancer so rate limits see real client IPs |
| `WEB_CONCURRENCY` | worker processes (`auto` = one per CPU); keep `WEB_CONCURRENCY × DB_POOL_MAX` under Postgres `max_connections` |
| `CSP_ENFORCE` | CSP ships in report-only mode; set `true` once the console is clean |

Migrations in `server/migrations` run automatically at boot under an advisory lock (safe with many instances); `npm run migrate` runs them alone.

## AI paste import (Gemini) - loads and trucks

`POST /api/ai/parse-loads` and `POST /api/ai/parse-trucks` send the pasted text to Gemini with a strict JSON schema. The AI does **not** pick from a city list: it returns each place as written plus its country, region and approximate coordinates, and the server resolves it against the city database (`server/src/lib/ai/cities.js`): spelling variants, Cyrillic / Latin / Uzbek apostrophes, old names, regions (e.g. "Xorazm" -> Urgench), fuzzy matching and a nearest-town fallback by coordinates. Everything is verified (enums, dates, numbers) and returned as one draft per load or truck, with amber flags on anything uncertain. Nothing is posted until the member reviews the drafts; posting goes through `POST /api/loads/bulk` / `POST /api/trucks/bulk` (all-or-nothing, max 40, quotas apply to the whole batch). Anything else in the post (payment terms, readiness, extra destinations, truck remarks) is kept in **Notes**.

Setup: create a key at <https://aistudio.google.com/apikey>, set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, a comma-separated fallback order - default `gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.8-flash`; a retired or overloaded model hands over to the next) on the server, then run `npm run ai:check` - it makes one real call and prints what the AI understood. Without a key the feature runs in **basic mode** (a simple rule-based reader for the standard flag/flag/cargo/truck/terms/phone layout, clearly labelled in the UI) so it is never missing; set `AI_FALLBACK=false` to switch it off instead.

Contact numbers are read in whatever way they are written - `979242400`, `97 924 2400`, `97924 24 00`, even `9 7 9 2 4 2 4 0 0`, with or without +998, `8 (903) 123-45-67` - and always stored as `+998979242400` (`server/src/lib/ai/phones.js`). The AI prompt is told to look for the number in every post (usually the last line), weights / truck counts / prices / dates are not mistaken for phones, and when a whole paste has exactly one number it is given to every load the model left without one.

Privacy/safety: pasted text (including phone numbers) is sent to Google's Gemini API - say so in your terms. The API key never reaches the browser; the pasted text is never logged; the pasted text is treated as data, not instructions; each member has an hourly budget (`AI_RATE_PER_HOUR`, default 200 reads; the owner is never limited; the error says when it works again) and parallel calls are capped (`AI_MAX_PARALLEL`).

### Russian (and Uzbek) input

Everything accepts Cyrillic: pasted posts, notes, company names, free-text search. Search is case-insensitive for Cyrillic regardless of the database locale (migration `009_text_fold.sql` adds `sng_fold()`; the database must be UTF8 - the migration refuses to run otherwise). City boxes understand Russian names and endings ("в Москве"), a country typed after the name ("ташкент уз"), nicknames ("Питер"), regions ("Хоразм") and text typed with the wrong keyboard layout ("Vjcrdf" -> Москва). Phones and tablets (under 1200px) use the card layout and the drawer menu.

### Near me

The board can search around the person: «📍 Near me» next to the origin of the loads search and the location of the trucks search, and «📍 Nearby loads / 🚚 Nearby trucks» in the Telegram bot. Everyone is asked once (a banner on the search pages, the browser's own permission box, or Telegram's share-location button); the position stays in the browser / in the bot's own record, can be forgotten any time (Settings → Location, or the bot's «delete my location» button) and is used only for the search. The API takes `nearLat` / `nearLng` (rounded to ~1 km on arrival) with `originRadius` (loads) / `locRadius` (trucks) in km; the screens speak miles (default 100 mi = 161 km, 25-300 mi) and `sort=nearest` lists the closest first with the distance (`dho`).

### Trucks and "My truck"

Members post trucks, not only loads. In the Telegram bot: «🚚 Post a truck» (the saved truck - only the place, the date and the destination are asked; step by step; or paste / forward a post and the AI reads it), «🚛 My trucks» (one card each: Edit / Renew / Delete) and «🛠 Truck profile». **My truck** is what a driver fills in once - type, capacity, volume, TIR / ADR / GPS / side loading, where it usually stands, plates, driver - in Settings → My truck on the website or in the bot (one record on the member's profile, `members.my_truck`, `PUT /api/me/truck`). It is the default for «Loads for my truck» (the board filtered to that type and nothing heavier than its capacity, around where it stands; also the default of «Nearby loads» in the bot, with a switch) and it pre-fills posting a truck. Plates and driver are never published. API: `PATCH /api/trucks/:id` (edit), `POST /api/trucks/:id/renew`. Trucks posted anywhere are also broadcast to the groups, one message each (`BOT_BROADCAST_TRUCKS=0` turns that off).

### Loads remove themselves

A load leaves the board 14 days after it was posted (most people never set a load date, and nobody posts freight further ahead), so old freight never piles up. The owner can switch this off or change the number of days (1-30) on the Members page ("Automatic removal of loads"); a shorter limit is applied at once. A background job (every minute, safe to run on many workers at once) closes the expired loads; members can press **Renew** on a load that is still available to start its clock again (the removal time is not shown). Closed posts are purged from the database after 90 days.

### City database

~6,000 places across CIS, Turkey, Iran, China and neighbours, each with alternative names (`aliases`) in Russian, Uzbek, English, Tajik, Kazakh, Kyrgyz ... and `population` (used to rank results). Migration `007_cities_gazetteer.sql` (towns of the whole region) is generated by `scripts/build-cities.mjs`; migration `013_cities_central_asia.sql` adds every populated place of Uzbekistan, Kazakhstan, Kyrgyzstan, Tajikistan and Turkmenistan (villages included) plus every district and region as an alias of its seat town, so typing a district ("Khuroson"), an old name ("Kuybyshevsk") or any script finds the right town. It is generated by `scripts/build-cities-centralasia.mjs` from the GeoNames country dumps (download commands are at the top of that script). Place data derived from [GeoNames](https://www.geonames.org/), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

**Countries as search targets.** In the search filters (not in posting forms) the city box also offers whole countries (`GET /api/cities?countries=1`: "UZ", "Узбекистан", "Oʻzbekiston" ...). Loads are filtered with `originCountry` / `destCountry`, trucks with `locCountry` (derived columns, migration `012`), so "UZ → KZ" is one search.

**Subscriptions (managed by hand, OFF by default).** On the Members page the owner switches on "Require a subscription", sets the free-trial length, the price text and the "how to pay" text. From then on a member is *in trial* (their sign-up date + trial days; members who joined earlier start their trial the moment it is switched on), *paid* (the owner adds 30 / 90 / 180 / 365 days on their card after they pay, and time adds up) or *expired*. Expired members lose the whole board (every marketplace route answers `402 subscription_required`, including AI paste and the Telegram bot's posting) but keep Account & Settings, which shows the price and how to pay; their open page locks and unlocks by itself (live events). The owner is never charged. A header chip shows the trial / last week of paid time.

**Individuals and companies.** Everyone starts as an individual (their name is shown on posts). In Settings, "I work with a company" reveals the company fields; until then none are asked for (`members.works_with_company`).

## Design for thousands of simultaneous users

What actually limits a marketplace is not requests per second but **what every open browser costs while it sits there**, and what happens when thousands of them react to the same event. The design targets that:

- **Live updates are cheap.** One `LISTEN` connection per process feeds Server-Sent Events. Board changes are **coalesced** (one frame per second per process, however many posts happened), so 20 posts/s does not mean 20 × users socket writes.
- **No thundering herd.** A change makes every browser refresh, so refreshes are spread randomly over ~15 s (`liveThrottle` in `web/js/util.js`), reconnects are jittered, and nav badges poll slowly instead of reacting to every event. Measured effect at 3,000 users: server-side search p50 **373 ms → 12 ms**.
- **Shared result cache.** Identical pages requested within 1.5 s are computed once (single-flight) and shared; per-user data (`mine`) is added afterwards, access control sits in front of the cache, and any write drops cached pages within 0.5 s so people see new posts immediately.
- **Every list query is a keyset-paginated index range scan** (no `OFFSET`) over partial indexes of *active* rows only, so closed history never slows the board. Totals are capped (`10,000+`) and cached; radius search = bounding-box scan + exact haversine; text search = trigram index; the 160 cities are served from memory.
- **Overload behaves.** A bounded database queue sheds excess API calls with `503 busy` + `Retry-After` (browsers retry reads after a randomised wait); a saturated pool never turns into a pile of 500s or an unbounded queue.
- **Abuse limits:** per-member quotas (500 active loads, 200 trucks, 200 posts/hour), per-IP rate limits, statement timeouts, body limits, strict validation, parameterised SQL, CHECK constraints.
- **Stateless API → scale out.** Add `WEB_CONCURRENCY` workers per machine and more machines behind a load balancer; PostgreSQL `LISTEN/NOTIFY` keeps every instance's caches and live streams consistent without Redis.

### What was measured — and what was not

`npm run soak` simulates real browsers (one live connection each, searches every 4–12 s, scrolling, nav polling, ~3 % posting) against the real API and a real PostgreSQL with 50,000 loads.

| Run (all on one 8-thread laptop that also runs the load generator and PostgreSQL; **1 API process**) | Result |
| --- | --- |
| 3,000 simultaneous users, 70 s | **0 errors**; server-side search p50 12 ms, p95 ≈ 280 ms (≈ 90 ms steady); a new post reaches open browsers in ≈ 0.8 s (p50) / 1.3 s (max); ~5,000 sockets open |
| 5,000 simultaneous users | one process saturates at ≈ 800 req/s: latency climbs and connections time out. That is the ceiling of a single process on this machine, **not** of the design |
| 5,000+ users with 3 workers | **not measured** — the laptop ran out of RAM (≈ 15 MB free) while hosting PostgreSQL, 3 workers and the simulated browsers |

So: one process comfortably serves ~3,000 simultaneous active users here; beyond that you add workers/instances. Nobody should trust a laptop for the final number — **run the soak on the real thing before launch**:

```bash
# self-contained (embedded PostgreSQL), on a big Linux VM; raise fd limits first:
ulimit -n 200000 && SOAK_USERS=20000 SOAK_SECONDS=180 DB_POOL_MAX=40 npm run soak

# or against a multi-worker server you started yourself (isolated test box only - it uses fake sign-in):
WEB_CONCURRENCY=8 npm run dev:fake-auth -- --seed 200000 --members 20000 &
SOAK_BASE=http://127.0.0.1:8080 SOAK_USERS=20000 npm run soak
```

**Sizing rule of thumb** (from the measured cost per active user ≈ 0.3 requests/s): 10,000 simultaneous users ≈ 3,000 req/s ≈ 4–8 API workers on dedicated cores plus a PostgreSQL with ≥ 8 vCPU / 32 GB, with `WEB_CONCURRENCY × DB_POOL_MAX` below `max_connections` (use PgBouncer in transaction mode beyond ~300 connections). Set the OS file-descriptor limit above the number of open live connections per instance (Docker/systemd: `LimitNOFILE=200000`). Postgres `NOTIFY` serialises commits briefly, which is fine for thousands of posts per minute; at tens of thousands of writes per second, move events to Redis/NATS (the `EventHub` is the only place to change).

## Telegram bot

`bot/` is a separate process that links a member's account (`/link`: phone number + the password; `/linkemail` keeps the older e-mail + password way), lets them `/postload` straight from a chat, and broadcasts every new load - from the web
app or from Telegram - to every group/channel the bot has been added to, the instant it is posted.
It talks to this same API and database; nothing on the server needed to change. See
[`bot/README.md`](bot/README.md) for setup (`npm run bot`) and how it works.

## Tests

```bash
npm test      # 148 tests. server: real embedded PostgreSQL - auth, approval, search, quotas, security, SSE, boot/cluster, i18n
              # bot (28): crypto + formatting + translations, and integration tests against the real API, database and
              #           LISTEN/NOTIFY channel (only Telegram itself is faked)
```

## Layout

```
server/src          Fastify app (routes, auth, events, config)
server/migrations   SQL schema (members, cities, loads, trucks, fx_rates, telegram_links/chats, indexes)
server/scripts      seed, benchmark, fake-auth dev server
server/test         integration tests
web/                browser app (web/js modules, Tailwind source) → built to web/dist
bot/                Telegram bot (account linking, /postload, broadcasting) - see bot/README.md
```
