# SNG ONE — Telegram bot

A separate process (`bot/`) that connects the loadboard to Telegram:

- **Link an account**: `/link your@email.com yourPassword` (DM only) signs in with the same e-mail +
  password the web app uses (Firebase Auth), so posting from Telegram obeys the exact same rules
  (quotas, required fields, approval status) as posting from the browser.
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
