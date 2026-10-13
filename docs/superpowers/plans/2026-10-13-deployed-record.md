# A re-run after a failed or interrupted deploy retries it (#862)

**Goal:** `deploy/deploy.sh` stops treating the checkout's `HEAD` as the
deployed commit. It records the commit that last passed the health check in a
file of its own, and compares against that. A re-run after a failed `up`,
health check, or killed run deploys again instead of answering "already at".

**Premise, as measured** (reading `deploy/deploy.sh` at `7a414be7`):

- Holds: after `deploy_failed`, `HEAD` is `$SHA`, so the next run computes
  `PREVIOUS=$SHA`, `merge-base --is-ancestor $SHA $SHA` succeeds, and it
  prints "already at or past" and exits 0.
- Holds: there is no `trap`, so a run killed during `build` or `migrate`
  leaves `HEAD` on `$SHA` while `$PREVIOUS` serves.
- Corrected: a dropped SSH session under `restrict` (no pty) most likely kills
  the remote side by SIGPIPE on its next write, not SIGHUP. The recorded
  commit covers either, so nothing depends on which.
- Not in the issue: DEPLOYMENT.md §6 *Rolling back* moves `HEAD` by hand. With
  a separate record, that recipe must also rewrite the record, or a re-run of
  the rolled-back-from commit answers "already at" while the older one serves.
- Measured locally (bash 5.3): an EXIT trap runs on SIGTERM and SIGHUP even
  without a signal trap. Explicit signal traps are used anyway, since the
  server's bash version was not checked.

**Decisions (agreed at the brainstorming gate, option A):**

- `DEPLOYED_FILE`, default `$APP_DIR/.deployed`, overridable like `LOCK_FILE`,
  and gitignored. Read as `PREVIOUS`; absent → fall back to `HEAD` (production
  has no file yet and seeds it on its next successful deploy).
- Written with `$SHA` only after the health check passes, before
  `docker image prune` and the final echo.
- A re-run for a commit not yet recorded runs the whole deploy again: build,
  migrate (already-applied migrations are skipped), `up`, health.
- After `checkout`, an EXIT trap checks `PREVIOUS` back out; `TERM`/`HUP`/`INT`
  traps `exit` with 128+signal so the EXIT trap runs. The EXIT trap is removed
  just before `up`. The build and migrate failure branches rely on that trap
  instead of their own `checkout` lines.

## Task 1: deploy.sh records the deployed commit and restores on interruption (TDD)

Files: `deploy/deploy.test.ts`, `deploy/deploy.sh`, `.gitignore`.

1. Test harness: pass `DEPLOYED_FILE` (inside the temp root) in `run()`'s env.
   Make the `docker` stub sleep on `build` when `FAKE_BUILD_SLEEP` is set
   (seconds), so a test can signal the script mid-build.
2. Tests, written first and seen to fail for the right reason:
   - Success writes `$SHA` to the record.
   - `FAKE_UP_FAIL`, then the same SHA again without it: the second run exits
     0, does not print "already", calls `build`, `run --rm migrate`, `up -d`,
     and the record is the SHA. The first run left the record unchanged.
   - Same with a failing health check, then a passing one.
   - Build and migrate failures leave the record unchanged (extend the
     existing tests).
   - SIGTERM during a sleeping build (spawn async, kill the bash pid): `HEAD`
     is back on the previous commit, the record is unchanged, no `up`.
   - No record file: the script falls back to `HEAD` (existing tests already
     start without one; assert explicitly in one test that it is created).
   - The existing "already deployed or older" test keeps passing.
3. Implement in `deploy.sh`; update its header comment so "already deployed"
   means the recorded commit. Add `/.deployed` to `.gitignore`.
4. **Prove each guard bites**, recording the failing test and its message:
   - delete the record write → the retry and record tests fail;
   - delete the EXIT trap (keep the explicit failure-branch behaviour out) →
     the SIGTERM test and the build/migrate restore tests fail;
   - read `PREVIOUS` from `HEAD` again → the retry tests fail.
   Restore and re-run green.

## Task 2: DEPLOYMENT.md §6 (after Task 1, so it describes shipped behaviour)

Files: `DEPLOYMENT.md`.

- Replace "Running the script again for the same commit then answers that it
  is already there and retries nothing: retry with … or roll back." with: the
  script records the commit that last passed its health check in
  `/opt/fairyoga/.deployed`, so running it again for the same commit (or
  re-running the CI job) deploys it again; or roll back.
- "It only moves forward": "already deployed" is the recorded commit.
- The setup test ("re-running the `deploy` job of the latest `main` run")
  answers "already there" only when that run succeeded; say so.
- *Rolling back*: add `git rev-parse HEAD > .deployed` after the `up`
  succeeds.
- A run killed before `up` puts the checkout back.

## After merge

Reinstall the forced-command copy (§6 *Setting it up*, step 1). The PR body
says so.
