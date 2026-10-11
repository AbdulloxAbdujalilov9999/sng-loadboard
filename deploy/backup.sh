#!/usr/bin/env bash
# Database backup:   bash backup.sh [label]      (cron runs it every night, see README)
# Writes /opt/sng/backups/sng-YYYYmmdd-HHMMSS[-label].dump and keeps the newest 14 nightly ones.
set -euo pipefail
cd "$(dirname "$0")"
DIR=${BACKUP_DIR:-/opt/sng/backups}
mkdir -p "$DIR"
label=${1:+-$1}
file="$DIR/sng-$(date +%Y%m%d-%H%M%S)$label.dump"
docker compose exec -T db pg_dump -U sng -Fc sng > "$file.tmp"
[ -s "$file.tmp" ] || { rm -f "$file.tmp"; echo "backup is empty - something is wrong"; exit 1; }
mv "$file.tmp" "$file"
echo "backup written: $file ($(du -h "$file" | cut -f1))"
# keep the newest 14 nightly backups (pre-update ones are cleaned after 30 days)
ls -1t "$DIR"/sng-*.dump 2>/dev/null | grep -v -- '-pre-update' | tail -n +15 | xargs -r rm -f
find "$DIR" -name 'sng-*-pre-update.dump' -mtime +30 -delete
