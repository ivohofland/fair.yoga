#!/usr/bin/env bash
# Nightly Postgres backup with 14-day rotation.
# Install on the VPS crontab, e.g.:
#   17 3 * * * /opt/fairyoga/deploy/backup.sh >> /var/log/fairyoga-backup.log 2>&1
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/fairyoga/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/fairyoga}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "$BACKUP_DIR/fairyoga-$STAMP.sql.gz"

# Rotate
find "$BACKUP_DIR" -name 'fairyoga-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "backup ok: $BACKUP_DIR/fairyoga-$STAMP.sql.gz"
