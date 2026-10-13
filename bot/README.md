# SNG ONE — Telegram bot

A separate process (`bot/`) that connects the loadboard to Telegram:

- **Link an account**: `/link your@email.com yourPassword` (DM only) signs in with the same e-mail +
  password the web app uses (Firebase Auth), so posting from Telegram obeys the exact same rules
  (quotas, required fields, approval status) as posting from the browser.
- **Buttons instead of commands**: `/start` shows a menu that stays at the bottom of the chat (AI posting, step-by-step posting, My loads,
  My account, Language, Help; labels follow the person's language - `src/menu.js`). "My account" shows the link status with Connect /
  Disconnect buttons. Every command still works for people who prefer typing; a menu tap also ends any open dialogue.
- **Sign up from Telegram**: «👤 My account» → «🆕 Create an account» asks for a name, the phone number (share button or typed) and a 4-6 digit password (twice; the messages are deleted), creates the account through `POST /api/auth/phone/register`, links this Telegram to it and sends a button that opens the website already signed in - a one-time link (`/?login=<code>`, 15 minutes, works once; only a hash is stored: migration 020, `POST /api/me/login-link` + `POST /api/auth/link-login`). Linked members get the same button from «👤 My account» → «🌐 Open the website». `src/signupScene.js`.
- **Near me (like DAT)**: «📍 Nearby loads» and «🚚 Nearby trucks» ask for the person's location once with Telegram's own share button, keep it (`telegram_users.geo_*`, migration 021) and show everything within 100 miles - nearest first, one message per result, 10 per page with «show more», radius buttons 25 / 50 / 100 / 200 / 300 miles, «update» and «delete my location» buttons. Any location sent later is a search too. It uses the board's `nearLat` / `nearLng` filters (`GET /api/loads`, `GET /api/trucks`). `src/nearby.js`.
- **Trucks**: «🚚 Post a truck» (`/posttruck`) - with the saved truck only the place, the date and the destination are asked; or step by step; or «🤖 describe it»: paste / forward a post and the AI reads it (`/api/ai/parse-trucks`), a review lists the trucks (🗑 drops one) and one tap publishes the rest (≤ 10 per review). «🚛 My trucks» (`/mytrucks`) lists them as cards with Edit / Renew / Delete (the same editor, target `T<id>`). `src/trucks.js`. Trucks posted on the website or here are also sent to the groups, one message each (`BOT_BROADCAST_TRUCKS=0` for loads only).
- **My truck (Profile)**: «🛠 Truck profile» (`/mytruck`) is the saved truck shared with the website's Settings (`members.my_truck`, migration 022): add it with type + capacity, then ✏️ Edit for the rest (editor target `M`). «🔎 Loads for it» and «📍 Nearby loads» use its type and capacity by default (a switch under the results turns that off); «🚚 Post it» posts it again in a few taps. `src/myTruck.js`.
- **Clear from chat**: after publishing (and under `/myloads`) a button removes the review, the copies of the posted loads and the pasted posts from the CHAT only (in one bulk call to Telegram, 100 at a time) - the loads stay on the board, in the groups and in «My loads»; a copy still on its way is not sent to that chat (`src/chatCleaner.js`).
- **AI paste-import** (same as the standalone `sng-ai-bot`, now built into this bot): in a DM, paste or forward a freight post
  (Russian or Uzbek, one load or many). The bot sends it to `POST /api/ai/parse-loads` (the same Gemini parser the website
  uses), shows every load with warnings for anything it had to guess, and posts them with one tap through `POST /api/loads/bulk`
  under the member's own account and quotas. Plain text typed inside `/link` or `/postload` still goes to those steps first,
  and groups are never read. Posts forwarded in a burst (each Telegram message arrives separately) are collected for `PASTE_DEBOUNCE_MS` (default 2500 ms after the last one) and read as ONE paste: one AI call, one review, one Post button. If the pasted posts carry somebody else's phone / Telegram (a forwarded post), tapping Post first asks whose contact the loads show: the member's own (replace) or the post's (keep - loads that came without a contact get the one the other loads carry); nothing is published until they choose. Everything pasted while a review is open joins that same review (up to 50 loads, one Post button always at the bottom); one tap publishes them all to the board (`POST /api/loads/bulk`, 50 max) and every group the bot is in. A big paste is cut at blank lines and the pieces are read in parallel; one load the board refuses (say, a pickup date long past) never stops the others - the rest is posted and the refused one stays in the review with its reason. Group broadcasts run one worker per chat, in parallel; every load is its own message in every chat (a group takes ~20 a minute, so 50 loads need ~2.5 minutes there; `BOT_BROADCAST_DIGEST=1` would merge bursts, off by default),  and `telegram_broadcasts` (migration 019) lets the bot send what a group missed after a restart (checked every minute). Big batches are sent at an even pace and Telegram's "slow down" answers are waited out; group broadcasts are spaced (`BOT_BROADCAST_GROUP_GAP_MS`, default 3100 ms = Telegram's 20 messages a minute per group). Every parsed load is its own message with ✏️ Edit / 🗑 Remove (fix the cities, truck type, weight,
  dates, rate, cargo, notes or contact before anything is posted); posting sends each load on as its own message with Edit /
  Renew / Delete buttons, and `/myloads` lists them all the same way (one message per load). The editor is `src/editor.js`.
  Code: `src/pasteFlow.js`; tuned with `AI_PASTE_MAX_PER_MIN` (default 20) and
  `PASTE_PENDING_TTL_MIN` (default 15).
- **Post from Telegram**: `/postload` walks through a few questions and ends with the same
  `POST /api/loads` call the web app makes - the load shows up on the web board immediately.
- **Broadcast everywhere**: add the bot to any group/channel and it posts every new load there
  automatically, the moment it is created - whether that load came from the web app or from
  `/postload` here. One `loads` table, one event, one broadcaster: there is no special "Telegram
  path" for a load to take. Each broadcast message carries its own link back to that exact load on
  the web board (`https://.../?load=<id>` - works for anyone with board access, opens a read-only
  detail view; see "Deep links" below).
- **English, Russian, Uzbek**: the same three languages the web app offers (`bot/src/i18n.js`).
  Auto-detected from Telegram's own client language on first contact; `/language` switches it.
  Groups get one fixed language for broadcasts (`BOT_BROADCAST_LANG`, since a group mixes people),
  while every DM follows that person's own choice.
- **Invites our own channel/group**: set `BOT_JOIN_CHANNEL`/`BOT_JOIN_GROUP` (no leading `@`
  needed) and the bot appends a line inviting people to join both - in the welcome message, the
  `/postload` confirmation, and every broadcast message (see `bot/src/format.js`'s `joinLines`).
  Leave either blank to omit it.

## How it works

```
Telegram  ──/link, /postload──▶  bot/  ──HTTPS (member's own ID token)──▶  Fastify API ──▶ Postgres
                                   │                                                          │
                                   └───────────── LISTEN sng_events (every insert) ◀──────────┘
                                   │
                                   ▼
                          every linked group/channel
```

The bot never duplicates the API's business logic. `/link` exchanges the member's e-mail+password
for a Firebase ID token exactly as the web sign-in form does, then stores the *refresh token*
(encrypted - see `src/crypto.js`) so it can mint a fresh ID token on demand. `/postload` and the
broadcaster both end up calling the real HTTP API or reading the real `loads` table - the same
source of truth the web app uses.

Broadcasting listens directly on the same Postgres `LISTEN sng_events` channel the API's
`EventHub` uses (`server/src/events.js`), but as its **own** connection: `EventHub` coalesces
bursts into one "something changed" frame per second for browsers (they just re-fetch), which
would lose individual loads. The bot instead reacts to every single insert and posts it.

### Deep links

`GET /api/loads/:id` (added to the API for this) returns one load by id. The web app
(`web/js/app.js`, `web/js/loads.js`) reads a `?load=<id>` query parameter once on sign-in, fetches
that load and shows it in a read-only modal - so every link the bot sends is a real, working,
load-specific URL, not just a link to the homepage. A closed/removed load shows "no longer
available" instead of an error. Build the link from `config.webBaseUrl` (`PUBLIC_WEB_URL`, see
below) + `/?load=` + the load's id - see `bot/src/broadcaster.js` and the `confirm:post` handler
in `bot/src/wizard.js` (the poster gets the same link as everyone else).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram → copy the token.
2. Add to `.env` (see `.env.example` for the full list):
   ```
   TELEGRAM_BOT_TOKEN=...
   FIREBASE_WEB_API_KEY=AIzaSyDryrZCdCuYNZrx8PQe83U4x3YL0Ipz3Hg   # already public, from web/js/config.js
   API_BASE_URL=http://127.0.0.1:8080        # or wherever the API is reachable from the bot
   PUBLIC_WEB_URL=                           # only if it differs from API_BASE_URL (see .env.example)
   BOT_ENCRYPTION_KEY=...                    # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   BOT_BROADCAST_LANG=en                     # en/ru/uz - language for messages sent to groups
   ```
3. Make sure the database has run the `006_telegram.sql` migration (automatic if the API is
   running with `AUTO_MIGRATE=true`, the default; otherwise `npm run migrate`).
4. Run it: `npm run bot` (or `npm run bot:dev` to restart on file changes).
5. In Telegram: DM the bot `/link your@email.com yourPassword`, then try `/postload`. Add it to a
   group to start broadcasting there.

Docker: `docker compose --profile bot up --build` (needs `TELEGRAM_BOT_TOKEN` and
`BOT_ENCRYPTION_KEY` set in the shell or an `.env` file next to `docker-compose.yml`). On Render,
`render.yaml` defines it as a second (worker) service.

## Ingestion bot: auto-importing loads from source groups

A **second, separate process** (`bot/src/ingestIndex.js`, `npm run ingest`) that joins the big
public Telegram groups where loads actually get posted in the SNG freight world - the ones with
thousands of members - reads every message, and turns the ones that look like loads into real
board listings automatically, no human in the loop. It reuses everything the "paste from
Telegram/WhatsApp" AI-import screen on the web app already does (`server/src/routes/ai.js`'s
Gemini parser, then `POST /api/loads` - see `server/src/routes/loads.js`): there is no second,
parallel way a load gets built or validated. The only new thing is *what triggers it* - a bot
reading a group instead of a person pasting text.

```
source group  ──message──▶  ingest bot  ──filter──▶  AI parse (/api/ai/parse-loads)  ──▶  dedupe
  (10k members)                                                                              │
                                                                                              ▼
                                                                          POST /api/loads (real API, real quotas)
```

### Why a second bot, and what it needs that the first one doesn't

- **Telegram privacy mode.** By default a Bot API bot in a group only sees `@mentions` and
  commands - not ordinary chat. This bot needs to see every message, so it needs its own
  `@BotFather` bot with privacy mode **disabled**: message `@BotFather` → `/mybots` → pick the bot
  → *Bot Settings* → *Group Privacy* → **Turn off** (or `/setprivacy` → *Disable*). Doing this on
  the *broadcast* bot from the section above would be harmless but pointless - keeping them
  separate means one bot's job (post-to-your-own-groups) and the other's (read-other-people's-groups)
  never share a token, a rate limit, or a crash.
- **Someone has to be able to add it to the group.** This only works for groups where you (or
  whoever runs the group) can add a bot - either because you admin it yourself, or the group's
  admins allow it. Many informal trading groups don't allow bots at all; there is no way around
  that short of running a personal Telegram account as an automated listener instead of a bot,
  which is a materially different (and riskier - against Telegram's ToS for automated accounts,
  and can get the *personal* account limited) approach this project deliberately does not implement.
  Where you can't add a bot, the practical fallback is still a human member using the existing
  AI-import screen on the web app to paste messages by hand.
- **A dedicated account to post as.** Every load needs an `owner_id` (a real member) and a
  `contactEmail`/`contactPhone`/`contactTelegram` (all required fields). There is no human pasting
  here to supply those, so you create one ordinary member account for this purpose - sign up on the
  web app with an e-mail you control (e.g. `telegram-import@yourdomain.com`), verify the e-mail,
  fill in its profile (**company** = something recognizable like "SNG ONE — Telegram Import",
  **phone**/**telegram** = a real line you monitor, since these become the contact shown on any
  auto-imported load whose source message didn't carry its own), and approve it from the owner
  account like any other member. Set `INGEST_SERVICE_EMAIL` / `INGEST_SERVICE_PASSWORD` to its
  login. It otherwise behaves like any member: the same active-loads cap and posts-per-hour quota
  apply (`MAX_ACTIVE_LOADS_PER_MEMBER`, `MAX_POSTS_PER_HOUR` in the main `.env.example` - raise them
  if this account hits the ceiling before a human would).

### What happens to each message

1. **Filter** (`ingestFilter.js`, no AI spent): too short, or - by default - no phone number/@handle
   anywhere in it, is dropped. This is most of the traffic in a big group (greetings, questions,
   "anyone going to Moscow?") and costs nothing to skip.
2. **Claim** (`telegram_ingest_messages`): the (chat id, message id) pair is recorded *before*
   anything else happens, so a Telegram-redelivered update or a bot restart mid-processing can never
   process - and therefore never post - the same message twice.
3. **Parse**: the message text goes to `POST /api/ai/parse-loads` (same Gemini prompt, same city
   resolution, same per-account hourly AI budget as a human's paste) and comes back as zero or more
   structured load drafts, one per load mentioned (a single message is often several loads).
4. **Per-draft dedupe** (`telegram_ingest_fingerprints`): a fingerprint of
   `origin city + dest city + pickup date + phone (or @handle)` blocks the same load from becoming a
   second listing - whether the same group reposts it an hour later (constant in these groups) or a
   dispatcher cross-posts the identical load to three different groups. The block lasts
   `INGEST_DEDUPE_WINDOW_HOURS` (default 72h) and keeps refreshing itself while the repost continues.
5. **Post**: a draft with no resolvable origin/destination city is skipped outright (the API would
   reject it anyway - there is nothing useful to post). Everything else is posted through the exact
   same `POST /api/loads` call `/postload` and the web app use, as the service account. If the AI
   had to estimate a field (weight defaulted to 20t, pickup date defaulted to today, rate defaulted
   to $0/negotiable - the same defaults the web import screen flags for a human to check), the load's
   notes get a short `auto-import: weight, rate estimated - confirm by phone` suffix instead of
   silently presenting a guess as fact.

A message that mentions several loads posts the ones that resolve and skips the ones that don't,
independently - one bad line in a message never blocks the good ones next to it.

### Setup

1. Create a **second** bot with `@BotFather`, disable its privacy mode (see above), and put its
   token in `TELEGRAM_INGEST_BOT_TOKEN`.
2. Sign up, verify, and approve a dedicated member account on the web app (see above); put its
   login in `INGEST_SERVICE_EMAIL` / `INGEST_SERVICE_PASSWORD`.
3. Make sure migration `007_telegram_ingest.sql` has run (automatic with `AUTO_MIGRATE=true`).
4. Get your own Telegram user id from `@userinfobot` and put it in `INGEST_ADMIN_TG_IDS` (comma
   separated if more than one person should be able to run the admin commands below).
5. Run it: `npm run ingest` (or `npm run ingest:dev`). Docker: `docker compose --profile ingest up
   --build`. On Render: the `sng-one-telegram-ingest` worker in `render.yaml`.
6. In Telegram, add that bot to each source group you have access to - you (or that group's admins)
   add it exactly like any other bot. It starts ingesting the moment it joins; nothing else to
   configure per group.

### Admin commands (DM only, `INGEST_ADMIN_TG_IDS` only)

- `/ingeststatus` — every source chat the bot is in, with message/load counts.
- `/pausesource <chatId>` — stop ingesting a noisy or low-quality group without removing the bot or
  redeploying (e.g. it turns out to be mostly spam, or a group where the AI keeps mis-reading the
  local dialect). `/ingeststatus` shows each chat's id.
- `/resumesource <chatId>` — undo a pause.

### Limitations / things you'd add for a bigger deployment

- One message = one AI call at most (`INGEST_AI_MAX_PER_MIN` throttles the rate, it doesn't batch).
  A poster who splits one load across two or three separate messages is read as separate, usually
  incomplete, drafts rather than merged - the common "flag/flag/cargo/truck/terms/phone in one
  message" layout (the actual norm in these groups) is unaffected.
- No human review step by design (the request this was built for is "fully automatic"). The safety
  net is entirely mechanical: the API's own field validation (bad data literally cannot be inserted)
  plus the transparency note on estimated fields. If you'd rather hold low-confidence drafts (any
  non-empty `flags` from the AI) for a person to confirm instead of auto-posting them with a caveat,
  that is a small change to `ingestPipeline.js`'s `toLoadBody`/posting step - route flagged drafts to
  a Telegram message to the admins instead of straight to `createLoad`.
- One ingest bot process = one Telegram "worker" for however many source groups you add it to, same
  constraint as the broadcast bot (see its own Limitations above) - shard across multiple ingest
  bots if you outgrow one.
- Content/ToS consideration worth knowing about rather than a code limitation: this republishes
  third-party freight posts (scraped from a group you don't control) onto your own commercial board,
  attributed to the service account rather than the original poster by name. That's normal practice
  among SNG freight aggregators, but it is your call per source group - whatever that group's own
  rules and your relationship with its admins actually allow - not something this code decides for you.

## Security notes

- `/link` only works in a private chat; the bot deletes the message containing the password
  (best-effort - Telegram lets a bot delete its own chat's messages).
- Passwords are never stored or logged - only the Firebase refresh token, and only encrypted
  (AES-256-GCM, key from `BOT_ENCRYPTION_KEY`, never committed, never sent to Telegram).
- `/postload` is DM-only too, since it may ask for contact details.
- Broadcasting a load's contact phone/e-mail/Telegram to every group the bot is in is **by
  design** - it is exactly the public contact info a member already chose to publish on their
  load (the same fields the web board shows every approved member), broadcast the way freight
  groups already work. If you want a group that should NOT receive broadcasts, remove the bot
  from it.

## Limitations / things you'd add for a bigger deployment

- One bot process = one Telegram "worker". If you need many thousands of broadcast chats, shard
  the `telegram_chats` list across multiple bot instances (the `LISTEN` fan-out already scales;
  only Telegram's own per-bot rate limit would need spreading across bots).
- `/postload` asks one field at a time in whichever of English/Russian/Uzbek the person has
  chosen; the web app's AI paste-import is not duplicated here on purpose - link, then use the
  richer web UI for anything beyond a quick post.
- No `/requestaccess` flow: a Telegram user must first sign up and request access on the web app;
  `/link` only works once an owner has approved them there.

## Things to know (from the integration review)

- **Who can `/link`**: only members who have an e-mail **password** on the web app. Members who sign in with
  Google, or with a phone number, have none: they open *Account → Sign-in & Security → "Email me a link to set a
  password"* first (the bot's `/link` help and the wrong-password reply say so, in all three languages). The e-mail
  must also be **confirmed** - an unconfirmed address gets its own "confirm your e-mail first" reply.
- **Passwords travel through Telegram.** Telegram bot chats are not end-to-end encrypted, so `/link` sends the
  web password through Telegram's servers (the bot deletes the message and never stores or logs the password).
  Acceptable for a start; the safer design for later is a one-time link code generated in the web app
  (*Account → Connect Telegram*) that the member sends to the bot instead of a password.
- **Rate limits**: every bot user posts from the bot's one server address, so the API's write limit
  (`WRITE_RATE_LIMIT_PER_MIN`) is counted **per member**, not per IP (`server/src/lib/memberlimit.js`); the general
  per-IP limit (`RATE_LIMIT_PER_MIN`, 600/min) still covers the bot as a whole - raise it if many people use the bot.
- **Telegram throttling**: Telegram allows ~20 messages a minute per group. When it answers `429`, the broadcaster
  waits the `retry_after` it is given and tries again (up to 4 times), so a 40-load AI import is delivered, just
  more slowly. Chats that no longer exist (`400 chat not found`) are dropped from the list.
- **`PUBLIC_WEB_URL`** must be your site's public `https://` address in production. If it is missing or internal
  (`localhost`, `http://sng-one:10000`), the broadcaster **leaves the "view this load" link out** instead of
  sending a dead one, and logs a warning at start-up.
- **Rate `0` / `-`** in `/postload` means "negotiable", like on the web board.
