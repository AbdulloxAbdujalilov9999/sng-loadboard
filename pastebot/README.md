# SNG ONE — AI paste-import bot

A third, independent Telegram bot alongside [`bot/`](../bot) (account linking, `/postload`,
broadcasting, and the ingest bot). This one has a single job: **a member pastes or forwards a
freight post, it splits it into draft loads and posts them to the board as them**, after they
review and tap one button.

```
member (DM)  ──paste text──▶  pastebot  ──/api/ai/parse-loads──▶  this API (Gemini + city DB)
                                  │                                        │
                                  │◀──────────── draft loads ─────────────┘
                                  ▼
                        shows each draft, flags anything uncertain
                                  │
                        member taps "✅ Post N loads"
                                  ▼
                        POST /api/loads/bulk (their own account, their own quotas)
```

It talks to this same API and database - nothing on the server needed to change - and shares
`bot/`'s `telegram_links` and `telegram_users` tables (migration `006_telegram.sql`): **a member
linked in either bot is linked in both**, no second `/link`.

The same code is also published as its own standalone repo,
[`sng-ai-bot`](https://github.com/AbdulloxAbdujalilov9999/sng-ai-bot), for anyone who
wants to run just this bot against a loadboard without cloning the whole app (e.g. a separate
Render service). Changes made here should be mirrored there, and vice versa.

## What it does

1. **`/link`** - same phone + PIN flow as `bot/` (DM only). `/linkemail` for older e-mail+password
   accounts. Required once before posting - without it the bot can't post as you. (Already linked
   via `bot/`? You're already linked here too.)
2. **Paste or forward any text** (Russian Cyrillic or Uzbek Latin/Cyrillic, one load or many, any
   layout) - sent to `POST /api/ai/parse-loads`, the exact same Gemini parser and city-resolution
   the website's "paste from Telegram/WhatsApp" screen and the ingest bot use.
3. **Review** - every parsed load is shown as its own numbered block: route, truck type, weight,
   cargo, pickup date, rate, notes, contact - with a warning line for anything the AI had to guess
   and a 🚫 marker on anything that can't be posted at all (city not matched, or origin/destination
   the same place).
4. **One tap posts the batch** - "✅ Post N loads" calls `POST /api/loads/bulk` (all-or-nothing)
   under the member's own linked account, falling back to their profile's phone/Telegram/company
   as the contact for any load the pasted text didn't carry one for. Unresolved-city loads are
   excluded and listed separately. "❌ Cancel" discards the batch.
5. **`/myloads`**, **`/mystatus`**, **`/unlink`**, **`/language`** - same as `bot/`.

What it deliberately does **not** do: broadcast to groups (`bot/`'s job), or auto-post without
review (the *ingest* bot's job, for public source groups nobody posts into as themselves).

## Setup

Needs this repo's API already running (same database, same `GEMINI_API_KEY`) and migration
`006_telegram.sql` applied (automatic on API boot).

1. Create a **third**, separate bot with [@BotFather](https://t.me/BotFather) - a different token
   from `bot/`'s and the ingest bot's.
2. Local dev: root `.env` needs `TELEGRAM_BOT_TOKEN` (this bot reads the same variable name as
   `bot/` - run them with different `.env` files, or see the Docker setup below which renames it
   to `TELEGRAM_PASTEBOT_TOKEN` at the host level), `DATABASE_URL`, `API_BASE_URL`,
   `FIREBASE_WEB_API_KEY`, and `BOT_ENCRYPTION_KEY` - **the same value `bot/` uses**, not a new
   one (both decrypt the same `telegram_links` row).
3. `npm run pastebot` (or `npm run pastebot:dev` to restart on file changes) from the repo root.
4. **Docker / Hetzner:** `docker compose --profile pastebot up -d --build` (root `docker-compose.yml`)
   or, on the production single-server stack, see [`../deploy/README.md`](../deploy/README.md)
   step 8 - set `TELEGRAM_PASTEBOT_TOKEN` in `deploy/.env` and run `deploy/update.sh`.
5. In Telegram: DM the bot, `/link` (or skip it if already linked via `bot/`), then paste a
   freight post.

## Tests

```bash
npm test   # from the repo root - runs server/bot/pastebot tests together
```

Pure unit tests only (draft-to-load-body conversion, postable/flag filtering, message formatting) -
no database or live Telegram connection needed.

## Layout

```
src/config.js       env vars
src/db.js           Postgres pool (same DB as server/ and bot/)
src/crypto.js       encrypts the stored session token at rest
src/firebase.js     /linkemail's e-mail+password sign-in (Firebase Identity Toolkit REST)
src/apiClient.js    every call to this API (parse-loads, loads/bulk, pin login, ...)
src/tokens.js       turns a stored link into a fresh API session token
src/store.js        telegram_links + telegram_users (shared with bot/)
src/linkScene.js    /link wizard (phone + PIN)
src/lang.js         per-person bot language
src/i18n.js         en/ru/uz translations
src/format.js       draft review blocks + posted-load lines
src/pasteFlow.js    the paste -> parse -> review -> bulk-post pipeline
src/bot.js          wires every command/action together
src/index.js        process entry point
```
