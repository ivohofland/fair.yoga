#!/usr/bin/env bash
# Deploy one commit of main to this VPS: check it out, build, migrate, restart,
# and wait for /api/health to report ok. DEPLOYMENT.md §6.
#
# CI calls it over SSH with a key whose authorized_keys entry forces this
# script (`command="…",restrict`), so the commit arrives in
# SSH_ORIGINAL_COMMAND and nothing else can run under that key. By hand:
#   fairyoga-deploy <full commit hash>
#
# It only moves forward along origin/main. The deployed commit is the one in
# DEPLOYED_FILE, written after the health check passes; the checkout's HEAD is
# only where the work tree stands. A commit already deployed, or older than the
# one deployed, answers success and changes nothing — two CI runs finishing out
# of order cannot roll the server back — except while the checkout is off the
# record, when it refuses instead. A commit not yet recorded runs the whole
# deploy again. Rolling back is a deliberate act by hand (DEPLOYMENT.md §6), not
# something this key can do.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fairyoga}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
LOCK_FILE="${LOCK_FILE:-/tmp/fairyoga-deploy.lock}"
DEPLOYED_FILE="${DEPLOYED_FILE:-$APP_DIR/.deployed}"

fail() { echo "deploy refused: $*" >&2; exit 1; }
# Once `up` starts, containers may have been replaced, so the checkout stays on
# $SHA and a failure is rolled back by hand.
deploy_failed() {
  echo "deploy failed: $*; $SHA is checked out, $PREVIOUS was before it (DEPLOYMENT.md §6, rolling back)" >&2
  exit 1
}

# SSH_ORIGINAL_COMMAND when set (even empty: a key-forced call with no
# command is still a request, and an empty one is refused), else the argument.
REQUEST="${SSH_ORIGINAL_COMMAND-${1-}}"
[[ "$REQUEST" =~ ^[0-9a-f]{40}$ ]] || fail "expected one full lowercase commit hash, got '${REQUEST}'"
SHA="$REQUEST"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another deploy is running"

cd "$APP_DIR"
git fetch --quiet origin main
git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null \
  || fail "$SHA is not on origin/main"

# When no record file exists, HEAD stands in for it, and is written down before
# the checkout moves, so it is a record from then on. A file that exists but is
# empty is not absent: it falls through to the check below and is refused.
if [[ -e "$DEPLOYED_FILE" ]]; then
  PREVIOUS="$(< "$DEPLOYED_FILE")"
else
  PREVIOUS="$(git rev-parse HEAD)"
  printf '%s\n' "$PREVIOUS" > "$DEPLOYED_FILE.tmp"
  mv "$DEPLOYED_FILE.tmp" "$DEPLOYED_FILE"
fi
[[ "$PREVIOUS" =~ ^[0-9a-f]{40}$ ]] \
  || fail "$DEPLOYED_FILE does not hold a full commit hash; write the deployed commit's hash into it (DEPLOYMENT.md §6)"
if git merge-base --is-ancestor "$SHA" "$PREVIOUS"; then
  # The checkout is off the record: a deploy ended after moving it without
  # passing its health check, or it was moved by hand. Which commit serves is
  # unknown.
  CHECKED_OUT="$(git rev-parse HEAD)"
  [[ "$CHECKED_OUT" == "$PREVIOUS" ]] \
    || fail "the checkout is at $CHECKED_OUT but $DEPLOYED_FILE says $PREVIOUS; which one serves is unknown — bring the checkout and the record to the serving commit (DEPLOYMENT.md §6)"
  echo "already at or past $SHA (deployed: $PREVIOUS); nothing to do"
  exit 0
fi
git merge-base --is-ancestor "$PREVIOUS" "$SHA" \
  || fail "deployed $PREVIOUS is not an ancestor of $SHA; deploy by hand"

echo "deploying $PREVIOUS -> $SHA"

# Build and migrate while the running app keeps serving; only `up` replaces
# it. Any exit before `up`, a failure or a signal, puts the checkout back where
# this run found it, which is not the record when an earlier swap failed: that
# HEAD is what makes the check above refuse. The signal traps turn TERM, HUP
# and INT into an exit, so the EXIT trap runs without depending on how a given
# bash treats a fatal signal. A dropped SSH session makes the next write to the
# dropped session fail; see the PIPE trap.
ENTRY_HEAD="$(git rev-parse HEAD)"
restore_checkout() {
  if ! git -c advice.detachedHead=false checkout --quiet --detach "$ENTRY_HEAD"; then
    echo "deploy: could not put the checkout back on $ENTRY_HEAD; it is left at $(git rev-parse HEAD 2>/dev/null || echo 'an unknown commit'), and the next run's check of HEAD against $DEPLOYED_FILE will refuse older commits" >&2 || true
  fi
}
trap restore_checkout EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
# Ignored, not handled: measured under bash 5.3, a PIPE handler did not reach
# the EXIT trap when the failing write was to stderr. Ignored, the write fails
# and `set -e` or `fail` exits through the EXIT trap. Every child inherits the
# ignore, so docker, say, sees EPIPE on a write instead of dying of the signal.
trap '' PIPE
git -c advice.detachedHead=false checkout --quiet --detach "$SHA"

# A postgres major cannot read the previous major's data directory, and `run`
# below already recreates `db` on a changed image, so a major change stops the
# database before anything here could notice. It is refused while nothing has
# been touched. A compose file without a postgres image on either side passes.
pg_major() { grep -oE 'image:[[:space:]]*postgres:[0-9]+' | head -n1 | grep -oE '[0-9]+$' || true; }
OLD_PG="$({ git show "$PREVIOUS:$COMPOSE_FILE" 2>/dev/null || true; } | pg_major)"
NEW_PG="$({ cat "$COMPOSE_FILE" 2>/dev/null || true; } | pg_major)"
if [[ -n "$OLD_PG" && -n "$NEW_PG" && "$OLD_PG" != "$NEW_PG" ]]; then
  fail "postgres $OLD_PG -> $NEW_PG is a data migration, not a deploy; upgrade by hand (#949)"
fi

if ! docker compose -f "$COMPOSE_FILE" build; then
  fail "build failed; no container was replaced"
fi
# Migrations run as their own step so a failing one leaves the app alone.
# Why: DEPLOYMENT.md §6.
if ! docker compose -f "$COMPOSE_FILE" run --rm migrate; then
  fail "migrate failed; no container was replaced (DEPLOYMENT.md §6, a failed migration)"
fi

trap - EXIT
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans \
  || deploy_failed "replacing the containers failed"

deadline=$((SECONDS + HEALTH_TIMEOUT))
until curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; do
  if (( SECONDS >= deadline )); then
    deploy_failed "$HEALTH_URL did not report ok within ${HEALTH_TIMEOUT}s"
  fi
  sleep 2
done

if ! { printf '%s\n' "$SHA" > "$DEPLOYED_FILE.tmp" && mv "$DEPLOYED_FILE.tmp" "$DEPLOYED_FILE"; }; then
  echo "deploy incomplete: $SHA passed its health check and serves, but $DEPLOYED_FILE could not be written; fix the file or its directory and run this again" >&2
  exit 1
fi
docker image prune -f >/dev/null \
  || echo "warning: docker image prune failed; $SHA is deployed and recorded" >&2
echo "deployed $SHA"
