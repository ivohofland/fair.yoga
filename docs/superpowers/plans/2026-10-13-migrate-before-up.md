# A failing migration refuses the deploy (#857)

**Goal:** `deploy/deploy.sh` runs the `migrate` service as its own step after
`build` and before `up -d`. A failing migration puts the checkout back and
replaces no container, the same way a failed build already does.

**Premise, as measured.** `deploy.sh` and `docker-compose.prod.yml` match the
issue's description: `app` depends on `migrate` with
`service_completed_successfully`, and `up -d --remove-orphans` is the only step
after `build`. Compose creates (and so replaces) every container before it
starts any, so a `migrate` that exits non-zero leaves `app` replaced by a
container that never starts. `set -e` then exits at `up -d`, before the
health-check loop and with the checkout left on the new commit. The issue's
Compose replica was not re-run here because this machine has no docker CLI, so
the issue's own measurement is what we rely on.

**Decisions (made without a gate; the run is non-interactive):**

- `docker compose -f "$COMPOSE_FILE" run --rm migrate` runs between `build` and
  `up`. On failure it checks `$PREVIOUS` back out and refuses with
  `migrate failed; still running $PREVIOUS`. The `migrate` inside `up -d` stays:
  first-time setup (DEPLOYMENT.md §2) relies on it, and after a successful run
  it has nothing left to apply.
- A failing `up -d` after a successful migrate now prints a message naming both
  commits and pointing at §6's rollback. The checkout is not put back, because
  `up` may already have replaced containers, so the new commit is what is (or
  was meant to be) running. The health-check failure is handled the same way.
- No `-T`. Compose v2 `run` detects the TTY itself, and the hand-run admin
  commands in DEPLOYMENT.md §8 already use `run --rm migrate` without it.

## Task 1: deploy.sh runs migrate as its own step (TDD)

Files: `deploy/deploy.test.ts`, `deploy/deploy.sh`.

1. In the test's `docker` stub, log every call as before and also:
   - exit 1 on `run` when `FAKE_MIGRATE_FAIL` is set;
   - exit 1 on `up` when `FAKE_UP_FAIL` is set.
2. Tests, written first:
   - The success test asserts the order `build` < `run --rm migrate` < `up -d`.
   - New: with `FAKE_MIGRATE_FAIL`, the exit is non-zero, HEAD is back at the
     previous commit, no `up` call is logged, and stderr names `migrate` and
     the previous commit.
   - New: with `FAKE_UP_FAIL`, the exit is non-zero, no `curl` is logged, and
     stderr names both commits and `rolling back`.
   - The build-failure test also asserts that no `run` call is logged.
3. Watch the new tests fail against the current script (RED). Record the
   failure text.
4. Implement it in `deploy.sh`. Update the header line ("check it out, build,
   restart…") so it names the migrate step.
5. GREEN: `pnpm exec vitest run deploy/deploy.test.ts`.
6. **Prove the guard bites.** Swap the order in `deploy.sh` (`up -d` before the
   migrate step) and confirm the order assertion fails. Delete the
   checkout-restore line in the migrate branch and confirm the migrate-failure
   test fails. Record both errors, restore, and re-run GREEN.

## Task 2: DEPLOYMENT.md §6

File: `DEPLOYMENT.md`.

- In §6's opening paragraph, describe the order build → migrate (its own step)
  → replace containers → health check. Say that a failed migration, like a
  failed build, puts the checkout back and replaces nothing.
- **Partial migrations.** Prisma runs each migration in its own transaction
  unless the migration opts out, so a failed `migrate deploy` can still leave
  earlier migrations of the same deploy applied, and leaves the failed one
  recorded as failed. The old code then serves against that schema. This is
  no worse than before the change. Tell the operator what to do: fix forward,
  using `prisma migrate resolve` where a migration is marked failed. State this
  only after checking Prisma's actual behaviour in the repo
  (`prisma migrate deploy` stops at the first failure).
- **Reinstall.** A change to `deploy/deploy.sh` takes effect on the server only
  after setup step 1's `install` is run again. Say so where step 1 already
  states it. This change itself needs that reinstall, and the PR body says so.
- Leave §2 line 64 ("applies Prisma migrations before the app starts") as is.
  It is still true.

## Whole-branch review, then PR

There are two tasks, so one whole-branch review follows, then one fix wave and
one scoped re-review. After that comes the PR, then CI, then
`/pr-review-toolkit:review-pr`, then a rebase-merge.
