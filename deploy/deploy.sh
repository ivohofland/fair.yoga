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
# of order cannot roll the server back. A commit not yet recorded runs the whole
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

# Without a record (the first deploy under this script) HEAD stands in for it.
if [[ -s "$DEPLOYED_FILE" ]]; then
  PREVIOUS="$(< "$DEPLOYED_FILE")"
else
  PREVIOUS="$(git rev-parse HEAD)"
fi
if git merge-base --is-ancestor "$SHA" "$PREVIOUS"; then
  echo "already at or past $SHA (deployed: $PREVIOUS); nothing to do"
  exit 0
fi
git merge-base --is-ancestor "$PREVIOUS" "$SHA" \
  || fail "deployed $PREVIOUS is not an ancestor of $SHA; deploy by hand"

echo "deploying $PREVIOUS -> $SHA"

# Build and migrate while the running app keeps serving; only `up` replaces
# it. Any exit before `up`, a failure or a signal, puts the checkout back so the
# tree matches what serves; it is a no-op while the checkout is still there. The
# signal traps turn a signal into an exit so the EXIT trap runs; PIPE is what a
# dropped SSH session raises on the next write.
restore_checkout() {
  git -c advice.detachedHead=false checkout --quiet --detach "$PREVIOUS" || true
}
trap restore_checkout EXIT
trap 'exit 143' TERM
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 141' PIPE
git -c advice.detachedHead=false checkout --quiet --detach "$SHA"

if ! docker compose -f "$COMPOSE_FILE" build; then
  fail "build failed; still running $PREVIOUS"
fi
# Migrations run as their own step so a failing one leaves the app alone.
# Why: DEPLOYMENT.md §6.
if ! docker compose -f "$COMPOSE_FILE" run --rm migrate; then
  fail "migrate failed; still running $PREVIOUS (DEPLOYMENT.md §6, a failed migration)"
fi

# From `up` on, containers may have been replaced and the checkout stays on $SHA.
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

printf '%s\n' "$SHA" > "$DEPLOYED_FILE.tmp"
mv "$DEPLOYED_FILE.tmp" "$DEPLOYED_FILE"
docker image prune -f >/dev/null
echo "deployed $SHA"
