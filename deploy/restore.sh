#!/usr/bin/env bash
# Restore a backup INTO the running database (replaces everything in it):   bash restore.sh /opt/sng/backups/sng-....dump
# Also how you move SNG ONE to another server: set the new server up, copy the dump over (scp), run this.
set -euo pipefail
cd "$(dirname "$0")"
f=${1:?usage: restore.sh <backup.dump>}
[ -s "$f" ] || { echo "no such backup: $f"; exit 1; }
read -r -p "This REPLACES the current database with $f. Type YES to continue: " ok
[ "$ok" = YES ] || { echo cancelled; exit 1; }
docker compose stop api bot 2>/dev/null || true
docker compose exec -T db psql -U sng -d postgres -c "DROP DATABASE IF EXISTS sng WITH (FORCE)" -c "CREATE DATABASE sng ENCODING 'UTF8' TEMPLATE template0"
docker compose exec -T db pg_restore -U sng -d sng --no-owner < "$f"
docker compose up -d
echo "restored. Check the site."
