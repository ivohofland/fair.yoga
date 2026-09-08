# Per-worktree database + dev-server isolation

Issue #517. Scope extended in brainstorming beyond #517's own ask (unit-tier
database contention) to also close `docs/test-database.md` §5's deferred
"future extension" — local integration/e2e from a worktree — since both are
one mechanism away from being solved together.

## The problem, as measured

#517 measured this development machine running many concurrent
worktree/agent sessions against **one shared Postgres container**,
`fairyoga-db-1` (`docker-compose.yml`, 6 days up at investigation time), all
of them pointing at the same two databases, `ethical_yoga` and
`ethical_yoga_test`. `pg_stat_activity` during one captured 5007ms stall
showed 269 backend PIDs from *other* worktrees' `unit`/`unit-sweeps` runs
touching tables the stalling test never wrote — concurrent load this
machine's own concurrent worktree count produces routinely. `git worktree
list` at design time shows ~30 linked worktrees, several already orphaned
(`(detached HEAD)`, no tracking branch) — the contention #517 measured is not
a rare condition on this machine, it is the steady state.

The mechanism #517 pinned is more specific than "database contention": a
standalone negative control replicating the exact query pattern ran 400
iterations with 0 slow rounds outside vitest, and a concurrent
`pg_stat_activity` poll recorded **zero non-idle rows** for the entire
stalled process's lifetime — the query never reached Postgres. The stall is
client-side (vitest worker CPU scheduling, or Docker's network path under
load), not a Postgres lock or slow query. Per-worktree databases remove
Postgres-side contention (catalog cache, connection accounting, table
stats) but are not proven to remove the client-side mechanism #517 actually
caught red-handed — see Non-goals.

Two further findings from this design's own investigation, not in #517:

1. **The isolation seam for integration/e2e already exists, unwired.**
   `playwright.config.ts:49,62` and `tests/helpers.ts:32` both read
   `INTEGRATION_BASE_URL`, with a comment at `tests/helpers.ts:25` stating it
   "exists for a worktree dev server on another port." Nothing today
   allocates that port, isolates that server's database, or manages its
   lifecycle — `solve-issue/SKILL.md:247-254` documents the resulting gap as
   a hard constraint: integration/e2e "can't run locally" from a worktree at
   all, "hard-wired to the dev server on `:3000`". This is what the user
   observed as "another port... still using the same db."
2. **A sharper hazard than #517's.** An existing worktree's checked-out
   `.env` (`.claude/worktrees/fix-512-handoff-timeout-flake/.env`) has
   `DATABASE_URL` pointed at the plain shared `ethical_yoga` — the real dev
   database the user's own `:3000` server reads. Every worktree today
   defaults to the live dev database, by accident of copy-paste, not by
   design. A `db:seed`/`db:reset` run from inside any worktree wipes real
   dev data. Nothing currently generates a worktree's `.env`
   programmatically — it is hand-copied, inconsistently, per worktree.

## Goals

1. `unit`/`unit-sweeps` get an isolated database per worktree — #517's own
   ask.
2. `integration`/e2e become runnable locally from a worktree, each against
   its own seeded database and its own dev-server port.
3. Zero new Docker containers — everything rides on the existing single
   `fairyoga-db-1` container.
4. One bootstrap command per worktree — folds in dependency install and
   `.env` generation, not just DB/port allocation.
5. Self-healing cleanup: databases and dev-server processes belonging to a
   removed or abandoned worktree get reaped automatically, without relying
   on every worktree-creation path (solve-issue, antigravity, native `git
   worktree`, ad hoc) to remember an explicit teardown step.
6. Closes the sharper hazard above: a worktree's default `DATABASE_URL`
   becomes its own isolated database, never the shared dev one.

## Non-goals

- **Not a proven fix for #517's client-side mechanism.** Database isolation
  removes the Postgres-side contention surface entirely; it does not
  address host-CPU-scheduling contention if that is the dominant cause
  (#517 could not separate the two). #517's "Broader timeout headroom"
  option (auditing other fast, concurrency-sensitive tests for the same
  5000ms exposure) remains open work this design does not replace.
- **Not deduplicating `node_modules` across worktrees.** ~30 worktrees ×
  independent `npm install` is real disk and time cost. A content-addressed
  package manager (pnpm) would fix it structurally but is an unrelated,
  larger migration. Flagged as a candidate follow-up issue if the cost
  bites, not attempted here.
- **Not changing CI's isolation.** CI's database is already isolated per
  run (`docs/test-database.md` §2/§3); nothing here touches
  `.github/workflows/ci.yml`.
- **Not adding a Postgres container per worktree.** Considered and
  rejected — see Approaches Considered.

## Approaches considered

**A. Per-worktree Postgres container.** Full resource isolation, but this
is exactly the "stacking a lot of leftover docker containers" the design
brief was raised to avoid — a container per worktree against ~30 current
worktrees, each needing its own port, its own startup cost, its own
teardown discipline. Rejected.

**B. Shared container, per-worktree logical databases, app server booted
ephemerally per test run** (via Playwright's own `webServer` auto-start,
already wired to `INTEGRATION_BASE_URL`). Simplest to wire — no new
lifecycle commands — but `verify/SKILL.md`'s own documented gotcha is that
`next dev`'s lazy per-route compilation causes real timeouts against the
*shared* `:3000` server; booting fresh per run reproduces that flake class
on every worktree, every invocation.

**C. Same isolation, prebuilt (`next build && next start`) instead of `next
dev`.** Removes the lazy-compile flake but a full build per invocation
(likely 30s-2min for this app) wrecks the fast local iteration loop this
feature exists to enable. CI can afford that cost because it amortizes
across one whole tier's run; a local "tweak, rerun one test" loop cannot.

**D. Shared container, per-worktree logical databases, explicitly-started
long-lived dev server (chosen).** Same DB/port isolation as B/C, but the
per-worktree `next dev` process is started once per work session
(`npm run worktree:up`) and stays warm across many test runs — the same
mental model `verify/SKILL.md` already uses for the shared `:3000`
instance, just private to one worktree. Avoids B's repeat cold-boot cost
and C's repeat build cost. Trade-off: one explicit step to remember, which
`solve-issue`/`verify` need to document (see Documentation updates below);
mitigated by the reap sweep so a forgotten `worktree:down` doesn't leak
resources indefinitely.

## Design

### 1. Worktree identity

A worktree's identity is the basename of its git admin directory:

```
slug = basename(git rev-parse --git-dir)
```

For a linked worktree this is a name git already treats as unique
(`.git/worktrees/<slug>/`); for the main checkout, `git rev-parse
--git-dir` equals `--git-common-dir` and there is no linked-worktree admin
directory at all. Every script in this design checks that equality first
and no-ops everything below it when true — **the main checkout's behavior
is unchanged**: plain `ethical_yoga`/`ethical_yoga_test`, `:3000`, no
registry entry, no `.env` regeneration (it already has a working one).

The slug is sanitized to `[a-z0-9_]` (lowercase, `-` → `_`) for use as a
Postgres identifier component, mirroring the existing safety check in
`tests/setup/unit-db.ts` (`/^[a-z0-9_]+$/i`). Truncated if needed to fit
Postgres' 63-byte identifier limit alongside the `ethical_yoga_test_`/
`ethical_yoga_dev_` prefixes.

### 2. The registry

A single JSON file at `<git-common-dir>/fairyoga-worktrees.json` — inside
the *main* repo's `.git`, which every linked worktree already shares as
common storage, so no new shared-location convention is needed. One entry
per slug: `{ port: number, pid: number | null }`.

This is **not** tethered to git's own per-worktree admin directory
(`.git/worktrees/<slug>/`), despite that directory's lifecycle looking like
a free ride (git creates and deletes it automatically on `worktree
add`/`remove`/`prune`). It was the first design and is wrong for one
reason: reap needs to find and kill a worktree's dev-server PID *after* the
worktree — and its admin directory — may already be gone (removed outright,
or, going by the several `(detached HEAD)` entries in this machine's
current `git worktree list`, managed by tooling that doesn't always leave a
clean `git worktree remove` behind it). Information that must outlive the
resource it describes cannot live inside that resource. The registry is
therefore self-managed and independent of whether git's own bookkeeping for
a given slug still exists.

Concurrency: writes are infrequent (worktree setup/teardown, not a hot
path) — a naive `mkdir`-based lock directory next to the registry file
(atomic, no new dependency) is sufficient; retry with backoff on contention.

**Port allocation:** scan the registry for claimed ports, pick the lowest
free one in `3100-3999` (clear of every port currently observed in use on
this machine — `ddev`, `open-webui` at 3010, `litellm` at 4000 — with
headroom). Allocated once per slug and kept stable for the worktree's
lifetime: `worktree:up`/`down` cycles reuse the existing port so `.env`'s
`INTEGRATION_BASE_URL` never goes stale between them. Only `pid` changes
across up/down.

### 3. `scripts/worktree-setup.ts`

Run once per worktree (documented as a required step — see Documentation
updates). Idempotent; safe to re-run.

1. Detect main checkout vs. linked worktree; no-op and exit if main
   checkout.
2. Derive the slug (§1).
3. Register the worktree and allocate a port if not already registered
   (§2).
4. `npm install` — folds in what `using-git-worktrees`'s generic Step 2
   already does, as one part of this single bootstrap rather than a
   separate manual step.
5. Generate `.env` from `.env.example` **only if `.env` does not already
   exist** (never clobbers hand edits — same "refuse rather than silently
   proceed on ambiguity" posture as the safety assertion in
   `tests/setup/unit-db.ts`), substituting:
   - `DATABASE_URL` → `postgresql://yoga:yoga_dev_password@localhost:5432/ethical_yoga_dev_<slug>`
   - `DATABASE_URL_TEST` → `postgresql://yoga:yoga_dev_password@localhost:5432/ethical_yoga_test_<slug>`
   - `INTEGRATION_BASE_URL="http://localhost:<port>"` (new line; also added,
     commented out, to `.env.example` itself, matching its existing style
     for optional vars)
6. Print the slug, port, both database names, and the next command
   (`npm run worktree:up`).

### 4. Database provisioning

`tests/setup/unit-db.ts`'s create-if-missing + `prisma migrate deploy`
logic is generalized into a shared, importable function (`provisionDatabase(url,
{ seed: boolean })` — same body, parameterized) used by two callers:

- The vitest `unit`/`unit-sweeps` **global setup**, unchanged in spirit —
  still provisions whatever `DATABASE_URL_TEST` resolves to, `seed:
  false`. In a worktree that URL now names `ethical_yoga_test_<slug>`
  instead of the shared `ethical_yoga_test`; in the main checkout, nothing
  changes.
- The new `worktree:up` script (§5), provisioning `ethical_yoga_dev_<slug>`
  (from the worktree's own `DATABASE_URL`) with `seed: true` — matching
  what `npm run db:seed` already does for the shared dev database, just
  scoped to this worktree's copy.

The vitest global setup additionally runs the **reap sweep** (§6) before
provisioning — cheap (one `git worktree list --porcelain`, one query
against `pg_database`), so every `npm test` invocation opportunistically
cleans up drift left by any other worktree, not just its own.

### 5. `npm run worktree:up` / `npm run worktree:down`

`worktree:up`:
1. Run the reap sweep (§6).
2. Provision `ethical_yoga_dev_<slug>`, seeded (§4).
3. Start `next dev -p <port>` detached (matching the existing "start dev
   server detached" habit already used for the shared `:3000` instance).
4. Record the PID in the registry against this slug.

`worktree:down`:
1. Kill the registered PID if the process is still alive (`kill -0` check
   first — best-effort, no error if already gone).
2. Set `pid: null` in the registry — the **port stays reserved** so a later
   `worktree:up` in the same worktree reuses it.

Neither command touches the databases. Database cleanup is exclusively the
reap sweep's job (§6) — a crashed session that never reaches
`worktree:down` still gets cleaned up on the next `npm test` anywhere on
the machine, rather than leaking until someone remembers to run it by hand.

### 6. Reap sweep

Pure diff, side effects injected (kept unit-testable without a real
Postgres or git checkout — see Testing):

1. `git worktree list --porcelain` → live slug set.
2. For every registry entry whose slug is **not** in the live set:
   - if `pid` is set and alive, kill it (`SIGTERM`, best-effort);
   - `DROP DATABASE IF EXISTS ethical_yoga_test_<slug>` and
     `ethical_yoga_dev_<slug>` against the shared container;
   - remove the entry from the registry.

Called at the top of the vitest global setup (§4) and at the top of
`worktree:up` (§5) — no separate cron/sweep process, matching this
project's existing "sweep runs opportunistically inside the operation that
needs a clean slate" pattern (e.g. the template-generation sweep) rather
than a standalone scheduled job.

### 7. Error handling

- **Registry file missing or unreadable JSON:** treat as empty and
  (re)initialize — never block setup on a corrupt registry; worst case is
  re-allocating a port for a slug that already had one, harmless since
  `worktree:up` always writes its own current PID.
- **Port collision at allocation time despite the scan** (a non-worktree
  process claimed it between scan and bind): `next dev` fails to bind;
  surface that failure rather than silently retrying with a different port
  the registry doesn't know about — a stable port per worktree is a design
  goal, not an implementation detail to paper over.
- **`worktree:up` run without `.env` present:** fails fast — `.env`
  generation (§3 step 5) is a precondition, not something `worktree:up`
  duplicates.
- **Playwright's `webServer` fallback:** `playwright.config.ts`'s
  `webServer.command: 'npm run dev'` still runs unparameterized (defaults
  to `:3000`) if `INTEGRATION_BASE_URL`'s URL isn't already responding when
  Playwright starts — i.e., if someone runs `playwright test` in a worktree
  without having run `worktree:up` first. Today this is silent: it would
  boot a plain `:3000` server using the worktree's now-isolated
  `DATABASE_URL`, on the wrong port, and green/red results would be
  confusing rather than clearly wrong. Add a fast precondition check ahead
  of `webServer` (`INTEGRATION_BASE_URL` set but not reachable → fail with
  an explicit "run `npm run worktree:up` first" message) instead of letting
  the existing fallback mask the missing step.

## Testing

The registry allocation and reap-diff logic (§2, §6) are pure functions —
given a registry snapshot and a live-slug set, they return an allocation or
a list of entries to reap; the actual `DROP DATABASE`, `kill`, filesystem,
and `git worktree list` calls are injected side effects, not called
directly. This makes them ordinary `unit`-tier vitest cases with no
Postgres or git dependency: port allocation avoids already-claimed ports
and is stable across repeated calls for the same slug; reap identifies
exactly the entries whose slug is absent from a given live set and leaves
the rest untouched; the `.env`-generation step's "never overwrite an
existing file" rule gets a components-free `unit` test against a temp
directory.

Not unit-testable in isolation: the actual `next dev -p <port>` boot and
the real `CREATE`/`DROP DATABASE` calls — those are exercised by the
acceptance checks below, run against the real shared container once
per implementation, not on every `npm test`.

## Acceptance criteria

1. `npm test`, run from two different worktrees concurrently, produces
   zero cross-worktree rows in a concurrent `pg_stat_activity` poll scoped
   to either worktree's own database name — the same measurement technique
   #517 used, now with a negative result to show.
2. `npm run worktree:up && npx playwright test` runs green from a fresh
   worktree with no manual port or `.env` configuration beyond the one
   `worktree-setup.ts` bootstrap.
3. Removing a worktree (`git worktree remove`) and then running `npm test`
   from any *other* worktree results in the removed worktree's two
   databases being dropped within that run.
4. Re-running `worktree-setup.ts` against a worktree that already has
   `.env` leaves it byte-identical.
5. Main-checkout behavior is unchanged: `ethical_yoga`/`ethical_yoga_test`,
   `:3000`, no registry entry created, verified by running the full
   existing `npm run verify` there after this ships.

## Documentation updates (implementation steps, not done here)

- `docs/test-database.md` §5 ("Future extension (not now)") gets replaced
  with a reference to this spec now that it's implemented; §3.1's table
  gains the per-worktree naming convention.
- `.env.example` gains the commented `INTEGRATION_BASE_URL` line (§3).
- `solve-issue/SKILL.md:247-254`'s "In a worktree, integration and e2e
  can't run locally" constraint is no longer true after this ships — update
  to point at `npm run worktree:up` and drop the "skip `--project
  integration`" instruction, while keeping the "never kill or restart
  `:3000`" rule for the *main* checkout's server untouched (that rule isn't
  about worktrees at all, and nothing here changes it).
- `verify/SKILL.md`'s launch recipe gains a worktree-specific variant
  pointing at `worktree:up`/the allocated port instead of `:3000`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
