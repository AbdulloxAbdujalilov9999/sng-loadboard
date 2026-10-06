# SNG ONE — freight marketplace for the CIS / Eurasia

Load board, truck board and carrier directory with owner-approved membership.
Node 22 + Fastify API · PostgreSQL · Firebase Google sign-in · vanilla-JS web app served by the same process.

```
browser ──HTTPS──▶ Fastify (N workers) ──▶ PostgreSQL
   │   ▲                │                      ▲
   │   └── SSE live ────┴── LISTEN/NOTIFY ─────┘
   └── Google sign-in (Firebase Auth) → ID token → verified by the API on every request
```

## What it does

- **Members only.** Anyone can sign in with Google and request access; they see nothing until an owner approves them (Approvals page, live).
- **Loads**: post, edit, close; search by origin/destination **with deadhead radius**, equipment, dates, weight, rate, distance, free text; sort by any column; infinite scroll.
- **AI paste import**: paste one or many Telegram/WhatsApp posts (Russian Cyrillic or Uzbek Latin/Cyrillic); Gemini splits them into separate loads and fills cities, cargo, truck type and notes; the member reviews and posts them all in one click. Details below.
- **Default contact info** in Account: pre-fills the contact fields of every new load and truck (still editable per post).
- **Trucks**: post availability with end date (auto-expires after 30 days without one); same radius/equipment/date search.
- **Carrier directory** of approved companies; **display currencies** (USD, RUB, KZT, UZS, KGS, TJS, BYN, AZN, GEL, AMD) with owner-editable rates; **English / Russian** UI; mobile layout.
- **Live updates**: new posts, approvals and rate changes reach open browsers within a second (Server-Sent Events, backed by Postgres `LISTEN/NOTIFY`).

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
5. Sign in with the owner email: you are the owner and can approve other companies. Any other host that can run a Docker container (Railway, Fly.io, a VPS) works the same way; use the `Dockerfile` and the variables in `.env.example`.

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

## AI paste import (Gemini)

`POST /api/ai/parse-loads` sends the pasted text plus our city list to Gemini with a strict JSON schema; the server then **verifies everything** (city labels against the database with a fuzzy fallback for Cyrillic/Uzbek spellings, enums, dates, numbers) and returns one draft per load. Nothing is posted until the member reviews the drafts; posting goes through `POST /api/loads/bulk` (all-or-nothing, max 40, quotas apply to the whole batch). Fields the text did not contain (weight, price, date) are filled with visible defaults and highlighted for checking; everything else from the post (payment terms, loading readiness, advance, extra destinations) is kept in the load's **Notes**.

Setup: create a key at <https://aistudio.google.com/apikey>, set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`, a comma-separated fallback order — default `gemini-3.1-flash-lite,gemini-3.5-flash,gemini-3.8-flash`; a retired or overloaded model hands over to the next) on the server, then run `npm run ai:check` — it makes one real call and prints what the AI understood. Without a key the feature runs in **basic mode** (a simple rule-based reader for the standard flag/flag/cargo/truck/terms/phone layout, clearly labelled in the UI) so it is never missing; set `AI_FALLBACK=false` to switch it off instead.

Privacy/safety: pasted text (including phone numbers) is sent to Google's Gemini API — say so in your terms. The API key never reaches the browser; the pasted text is never logged; the pasted text is treated as data, not instructions; each member has an hourly budget (`AI_RATE_PER_HOUR`) and parallel calls are capped (`AI_MAX_PARALLEL`).

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

## Tests

```bash
npm test      # 68 tests against a real, embedded PostgreSQL: auth, approval flow, search, quotas, security, SSE, boot/cluster
```

## Layout

```
server/src          Fastify app (routes, auth, events, config)
server/migrations   SQL schema (members, cities, loads, trucks, fx_rates, indexes)
server/scripts      seed, benchmark, fake-auth dev server
server/test         integration tests
web/                browser app (web/js modules, Tailwind source) → built to web/dist
```
