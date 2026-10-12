#!/usr/bin/env bash
# Deploy the latest version from GitHub. Run on the server:   bash /opt/sng/app/deploy/update.sh
# Safe to run any time: data lives in Docker volumes and is never touched; database changes apply at startup.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "deploy/.env is missing (copy env.example)"; exit 1; }

# Phone + PIN sign-in needs a long random secret (never stored in git). Made once, kept in .env; losing it only signs everyone out.
if ! grep -q '^AUTH_SECRET=.\+' .env; then
  sed -i '/^AUTH_SECRET=/d' .env
  [ -z "$(tail -c1 .env)" ] || echo >> .env   # make sure the file ends with a newline first
  printf 'AUTH_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> .env
  echo "generated AUTH_SECRET (phone + PIN sign-in)"
fi

git -C .. fetch --quiet origin
before=$(git -C .. rev-parse --short HEAD)
git -C .. pull --ff-only --quiet
after=$(git -C .. rev-parse --short HEAD)
echo "code: $before -> $after"

# take a safety backup first when there is something new to deploy
if [ "$before" != "$after" ] && docker compose ps --status running --services 2>/dev/null | grep -q '^db$'; then
  bash ./backup.sh pre-update || echo "warning: backup failed, continuing"
fi

PROFILES=()
grep -q '^TELEGRAM_BOT_TOKEN=.\+' .env && grep -q '^BOT_ENCRYPTION_KEY=.\+' .env && PROFILES+=(--profile bot)
grep -q '^TELEGRAM_PASTEBOT_TOKEN=.\+' .env && grep -q '^BOT_ENCRYPTION_KEY=.\+' .env && PROFILES+=(--profile pastebot)
docker compose "${PROFILES[@]}" up -d --build --remove-orphans
docker image prune -f >/dev/null
# pick up changes to Caddyfile / sites/*.caddy without restarting the proxy
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

# wait until the API answers
for i in $(seq 1 40); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "OK - SNG ONE is running ($after)"; exit 0
  fi
  sleep 3
done
echo "The API did not become healthy - check:  docker compose logs --tail=100 api"; exit 1
