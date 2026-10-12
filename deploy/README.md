# Deploying SNG ONE on one server (Hetzner)

Stack on the server: **Caddy** (HTTPS, automatic certificates) → **API** (also serves the web app) → **PostgreSQL**, plus two optional Telegram bots (broadcast/`/postload` and the AI paste-import bot). All in Docker; data lives in Docker volumes and survives every update.

## First-time setup (about 20 minutes)

1. **Create the server** (Ubuntu 24.04, CPX22, Helsinki, your SSH key). In the Hetzner console add a **Firewall** allowing only TCP 22, 80, 443 (and UDP 443) and attach it to the server. Turn on **Backups**.
2. **Point a name at it.** Either a domain you own (an `A` record → the server IP), or, to test right away, the free name `<ip-with-dashes>.sslip.io` (for `2.29.41.94` that is `2-29-41-94.sslip.io`).
3. **Log in** and prepare the machine (once):
   ```bash
   ssh root@SERVER_IP
   git clone https://github.com/AbdulloxAbdujalilov9999/sng-loadboard.git /opt/sng/app   # private repo: see "Private repository" below
   bash /opt/sng/app/deploy/setup-server.sh
   ```
4. **Configure:**
   ```bash
   cd /opt/sng/app/deploy
   cp env.example .env && nano .env      # SITE_ADDRESS, POSTGRES_PASSWORD, OWNER_EMAILS, GEMINI_API_KEY ...
   ```
5. **Start:**
   ```bash
   bash update.sh
   ```
   The first build takes a few minutes. Then open `https://<SITE_ADDRESS>`.
6. **Firebase:** console → Authentication → Settings → **Authorized domains** → add your `SITE_ADDRESS`. Without this, Google/phone sign-in is refused on the new address.
7. **Telegram bot (optional):** put `TELEGRAM_BOT_TOKEN` and `BOT_ENCRYPTION_KEY` in `.env`, run `bash update.sh` again (it starts the bot when a token is set).
8. **AI paste-import bot (optional, a separate @BotFather token):** put `TELEGRAM_PASTEBOT_TOKEN` in `.env` (reuses `BOT_ENCRYPTION_KEY` from step 7 - it must be the same value), run `bash update.sh` again. A linked member pastes/forwards a freight post in DM and gets it back as draft loads to post with one tap - see [`../pastebot`](../pastebot) (`sng-ai-paste-bot` on GitHub is the same code, kept as its own repo for independent deploys elsewhere).

### Private repository
Create a read-only key on the server and add it in GitHub → repo → Settings → **Deploy keys**:
```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/github_deploy && cat ~/.ssh/github_deploy.pub
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n' >> ~/.ssh/config
git clone git@github.com:AbdulloxAbdujalilov9999/sng-loadboard.git /opt/sng/app
```

## Updating (every time)
```bash
bash /opt/sng/app/deploy/update.sh
```
It backs up the database, pulls the new code, rebuilds, restarts (a few seconds of downtime) and checks the API is healthy. Database changes apply automatically at startup.

**Automatic:** `.github/workflows/deploy.yml` runs that command on every push to `main`. Switch it on with the repo variable/secrets listed at the top of that file.

**Roll back:** `cd /opt/sng/app && git checkout <older-commit> && bash deploy/update.sh` (then `git checkout main` when fixed). If a database change must be undone, restore the pre-update backup (below).

## Backups
- Every night 03:15 → `/opt/sng/backups/` (newest 14 kept); one more before each update.
- **Copy them off the server** now and then (the server's own disk is not a second copy):  
  `scp root@SERVER_IP:/opt/sng/backups/<newest>.dump .` — or use Hetzner's server Backups as well.
- **Restore:** `bash /opt/sng/app/deploy/restore.sh /opt/sng/backups/<file>.dump`
- **Test a restore once** before you rely on it.

## Moving to a bigger server
Set the new server up (steps 1-4), copy the latest `.dump` and your `.env` over, run `restore.sh <dump>`, then `bash update.sh`, check the site, then move the DNS name to the new IP. The old server keeps working until you switch. In Hetzner you can also simply **resize** the same server (Rescale) - the disk and data stay.

## Other projects on the same server
Run each project in its own folder/Docker project on its own port (e.g. 127.0.0.1:3000), then give it a name by adding `deploy/sites/<project>.caddy`:
```
truckerz.example.com {
	reverse_proxy host.docker.internal:3000
}
```
and `cd /opt/sng/app/deploy && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.

## Useful commands (run in /opt/sng/app/deploy)
```bash
docker compose ps                 # what is running
docker compose logs -f --tail=100 api
docker compose --profile bot logs -f bot
docker compose --profile pastebot logs -f pastebot
docker stats --no-stream          # memory / CPU
```
