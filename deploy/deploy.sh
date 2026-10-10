#!/usr/bin/env bash
# Deploy one commit of main to this VPS: check it out, build, restart, and
# wait for /api/health to report ok. DEPLOYMENT.md §6.
#
# CI calls it over SSH with a key whose authorized_keys entry forces this
# script (`command="…",restrict`), so the commit arrives in
# SSH_ORIGINAL_COMMAND and nothing else can run under that key. By hand:
#   fairyoga-deploy <full commit hash>
#
# It only moves forward along origin/main. A commit already deployed, or
# older than the one deployed, answers success and changes nothing — two CI
# runs finishing out of order cannot roll the server back. Rolling back is a
# deliberate act by hand (DEPLOYMENT.md §6), not something this key can do.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fairyoga}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
LOCK_FILE="${LOCK_FILE:-/tmp/fairyoga-deploy.lock}"

fail() { echo "deploy refused: $*" >&2; exit 1; }

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

PREVIOUS="$(git rev-parse HEAD)"
if git merge-base --is-ancestor "$SHA" "$PREVIOUS"; then
  echo "already at or past $SHA (deployed: $PREVIOUS); nothing to do"
  exit 0
fi
git merge-base --is-ancestor "$PREVIOUS" "$SHA" \
  || fail "deployed $PREVIOUS is not an ancestor of $SHA; deploy by hand"

echo "deploying $PREVIOUS -> $SHA"
git -c advice.detachedHead=false checkout --quiet --detach "$SHA"

# Build while the running containers keep serving; only `up` replaces them.
# A failed build puts the checkout back, so the tree matches what runs.
if ! docker compose -f "$COMPOSE_FILE" build; then
  git -c advice.detachedHead=false checkout --quiet --detach "$PREVIOUS"
  fail "build failed; still running $PREVIOUS"
fi
docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

deadline=$((SECONDS + HEALTH_TIMEOUT))
until curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; do
  if (( SECONDS >= deadline )); then
    echo "deploy failed: $HEALTH_URL did not report ok within ${HEALTH_TIMEOUT}s; $SHA is running, $PREVIOUS was before it (DEPLOYMENT.md §6, rolling back)" >&2
    exit 1
  fi
  sleep 2
done

docker image prune -f >/dev/null
echo "deployed $SHA"
