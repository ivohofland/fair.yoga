#!/usr/bin/env bash
# Nightly Postgres backup, encrypted with age, with 14-day rotation.
# Install on the VPS crontab, e.g.:
#   17 3 * * * /opt/fairyoga/deploy/backup.sh >> /var/log/fairyoga-backup.log 2>&1
#
# The dump is encrypted on this host to the public key(s) in
# AGE_RECIPIENTS_FILE, so it never touches disk in plaintext and this host
# cannot read its own backups. The private key stays with the operator
# (DEPLOYMENT.md §4, including restore). Without a recipients file the script
# refuses rather than write a readable dump.
set -euo pipefail
umask 077

COMPOSE_FILE="${COMPOSE_FILE:-/opt/fairyoga/docker-compose.prod.yml}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/fairyoga}"
KEEP_DAYS="${KEEP_DAYS:-14}"
AGE_RECIPIENTS_FILE="${AGE_RECIPIENTS_FILE:-/etc/fairyoga/backup-recipients.txt}"

if ! command -v age >/dev/null 2>&1; then
  echo "backup refused: age is not installed (apt install age)" >&2
  exit 1
fi
if [ ! -s "$AGE_RECIPIENTS_FILE" ]; then
  echo "backup refused: no age recipients in $AGE_RECIPIENTS_FILE (DEPLOYMENT.md §4)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FINAL="$BACKUP_DIR/fairyoga-$STAMP.sql.gz.age"
# Written under a name rotation and a puller's glob both skip, and renamed
# only once the whole pipeline has succeeded: a failed dump leaves nothing
# that looks like a backup.
PARTIAL="$BACKUP_DIR/.fairyoga-$STAMP.partial"
trap 'rm -f "$PARTIAL"' EXIT

docker compose -f "$COMPOSE_FILE" exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip \
  | age -R "$AGE_RECIPIENTS_FILE" > "$PARTIAL"
mv "$PARTIAL" "$FINAL"

# Rotate — the encrypted dumps, and the plaintext ones this script wrote
# before it encrypted.
find "$BACKUP_DIR" -maxdepth 1 \( -name 'fairyoga-*.sql.gz.age' -o -name 'fairyoga-*.sql.gz' \) \
  -mtime "+$KEEP_DAYS" -delete

echo "backup ok: $FINAL"
