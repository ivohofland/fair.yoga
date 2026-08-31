# Spec: dedicated test database for vitest

Status: **implemented** · Owner: dev · Scope: local development; the CI
half followed in #321 (see §2)

## 1. Problem

All test tiers currently share the developer's database (`ethical_yoga`)
with the dev server and the seed data. This bit us concretely: the
class-transition service tests inject a far-future clock (2099) into
sweep functions that scan the *whole* database — a `npm test` run marched
the seed's future Sunday class through `open → in_progress → completed`,
created real payments, and sent "class completed" notifications that
surfaced in the teacher's inbox two days before the class.

The interference runs both ways:

- **Tests corrupt dev data** — sweeps, cleanup bugs, or any fixture
  mistake lands in the database the developer is looking at.
- **Dev data flakes tests** — service tests that count or sweep must
  carefully scope their assertions around whatever seed/exploration rows
  happen to exist (we have already fixed two flakes of this kind).

## 2. Goals / non-goals

**Goals**

1. `npm test` never mutates the dev database's seed/exploration data.
2. Service/unit tests run against a deterministic, empty-by-default
   database.
3. Zero changes to CI (its database is already throwaway). **Superseded
   by #321 and #325**, which split CI's single `test` job into `test-components`,
   `test-unit`, `test-integration` and `test-e2e`.
4. Zero extra steps in the daily loop — no manual database creation, no
   separate migrate command to remember.

**Non-goals**

- Isolating **Playwright e2e** or the **integration tests** from the dev
  server. Both talk to the app on `:3000`, and that app reads the dev
  database; pointing their fixtures elsewhere would break them. See §5.
- Per-test-file database isolation or transactional rollbacks (heavier
  machinery than this codebase needs). Since #321 `fileParallelism` is
  per-project, not global: `unit` and `components` run their files in
  parallel; `unit-sweeps` never does. `integration`'s project config is also
  `fileParallelism: false`, but that is only its LOCAL default — a bare
  `vitest run --project integration`, or `npm run verify`. CI's own
  integration step passes `--file-parallelism` on the command line (#325),
  and a CLI flag overrides a project's own setting: measured on vitest
  **4.1.10**, two files with a 2s sleep each completed in ~2.1s under the
  flag versus ~4.3s without it, in this repo's own `integration` project.
  CI's integration tier has run its files in parallel, against the
  pre-built standalone server, since #325. What keeps the parallel `unit`
  pool honest is that each file mutates only rows it owns —
  `class-generator.test.ts` was fixed by scoping its calls instead of being
  quarantined, and an unscoped `deleteMany`/`updateMany` surfacing in that
  pool is a bug. Scoping is only available when there is something to scope:
  a file that calls an unscoped *service* sweep cannot fix itself that way,
  because the damage lands on the sibling's rows rather than its own.

  A file testing a service whose sweep writes rows it was never handed,
  with no scope parameter to pass, belongs in `unit-sweeps` instead — the
  roster is `SWEEP_TESTS` in `vitest.config.ts`, not a count in this
  document, and it turned out to hold far more files than expected once
  #321 went looking for the criterion systematically rather than one
  failure at a time.

  `fileParallelism: false` on `unit-sweeps` is what isolates it, and it
  isolates more than the option's name suggests: vitest routes such a project
  into a `sequential` group appended after the parallel groups, so it never
  runs beside them. Measured on vitest **4.1.10** by timing file start/end
  across a parallel and a serial project in one invocation — parallel files
  overlapped each other every run, no serial file ever overlapped a parallel
  one, in either declaration order, against a control of two parallel
  projects that overlapped freely. `unit` and `unit-sweeps` in one invocation
  then ran green 5/5 (68 files, 1068 tests).

  **Three conditions gate that routing and the option's name covers only
  one.** Re-derive them:

  ```
  grep -n "sequential.specs.push" node_modules/vitest/dist/chunks/cli-api.*.js
  ```

  which on 4.1.10 reads `isolate === true && order === 0 && maxWorkers === 1`.
  `fileParallelism: false` is what sets `maxWorkers` to 1. The other two were
  mutation-tested against this repo's own config, and neither is a silent
  hazard: `isolate: false` makes vitest refuse the run outright ("Projects
  ... have different 'maxWorkers' but same 'sequence.groupOrder'", zero tests
  executed), and `sequence: { groupOrder: 1 }` stays green — the tier simply
  gets its own group, still awaited after the parallel one. So the flag is
  the only one of the three that can quietly stop protecting this tier. All
  of this is vitest-internal with no compatibility promise; pin the version
  when re-deriving.

  Mutation-tested: flipping `unit-sweeps` to `fileParallelism: true` reddens
  the tier (1 failed file, 2 runs of 2) with both invocation boundaries still
  in place — so the flag is load-bearing and can fail, and the boundaries are
  not what separates the tiers. The separate `vitest run` invocation in
  `package.json` and the two separate steps in `ci.yml` are defence in depth.

## 3. Design

### 3.1 The vitest projects

Vitest 4's `projects` config splits the suite by blast radius. The roster of
each is in `vitest.config.ts`; this table is the shape, not the membership:

| Project | Files | Database |
|---|---|---|
| `unit` | `src/**/*.test.ts` minus `SWEEP_TESTS` | **`ethical_yoga_test`** |
| `unit-sweeps` | `SWEEP_TESTS` | **`ethical_yoga_test`** |
| `integration` | `tests/integration/**/*.test.ts` | dev `ethical_yoga` (unchanged — must match the running app) |
| `components` | `src/**/*.test.tsx` | none (jsdom) |

`--project <name>` selects one tier. A bare `npx vitest run` runs all of
them, `integration` included, which needs the app up on `:3000` — use
`npm test`, which sequences the tiers, rather than running vitest directly.
The dangerous tests — everything that calls a service sweep with an injected
clock — are the `unit-sweeps` roster.

**`npm test` is two invocations joined by `&&`, so a red first half means the
second half never runs at all.**

```
vitest run --project unit --project components && vitest run --project unit-sweeps --project integration
```

A single failing `unit` test therefore produces a run in which `integration`
reports nothing — not zero failures, *nothing*. The output looks like a
one-line failure and is silently missing 519 tests. Measured on #315, where it
masked the integration project for most of a branch's life; the branch had 63
real integration failures nobody could see, because 16 unit tests were red.

Two consequences worth stating separately, because they are easy to conflate:

- **A green `npm run verify` genuinely is the whole suite.** The `&&` cannot
  produce a false green — if the second invocation did not run, the exit code
  is non-zero. So "green verify ⇒ every project ran" holds.
- **A red one tells you nothing about the projects after the failure.** Do not
  read a red `verify` as "integration passed" or as a count of what is broken.
  Run `npx vitest run --project integration` directly to see that tier while
  anything earlier is failing.

### 3.2 URL convention

- `.env` gains `DATABASE_URL_TEST` (same Postgres server, database
  `ethical_yoga_test`).
- `vitest.config.ts` loads `.env` and sets
  `env.DATABASE_URL = DATABASE_URL_TEST ?? DATABASE_URL` on **both
  database-backed unit projects** (`unit` and `unit-sweeps`, each declaring
  it independently). CI sets `DATABASE_URL_TEST` explicitly — see §2 and
  `.github/workflows/ci.yml` — so the runtime guard in
  `waitlist-retention.test.ts` does not skip that suite on the merge gate.
- Safety assertion in global setup: if `DATABASE_URL_TEST` is set, it
  must differ from `DATABASE_URL`; refuse to run otherwise (a typo must
  not silently reintroduce the shared-database hazard).

### 3.3 Provisioning + migrations (global setup)

A `tests/setup/unit-db.ts` vitest `globalSetup` for the `unit` and
`unit-sweeps` projects:

1. Connect to the Postgres server (the `postgres` maintenance database)
   and `CREATE DATABASE ethical_yoga_test` if it doesn't exist —
   idempotent, so a fresh clone needs no manual step.
2. Run `prisma migrate deploy` against `DATABASE_URL_TEST` — a no-op
   (<1s) when up to date, keeps the schema in lockstep with dev
   automatically after every `prisma migrate dev`.

No seeding: unit tests build their own fixtures (they already do) and
benefit from an empty database — assertion scoping becomes trivial.

### 3.4 What deliberately stays on the dev database

- **Integration tests** (`tests/integration/`) create fixtures via
  Prisma and call the HTTP API on `:3000` — the dev server reads the dev
  database, so fixtures must live there. Their operations are targeted
  (own teacher/class/student rows, cleaned in `afterAll`), never global
  sweeps; residual risk is limited to their own fixture rows.
- **Playwright e2e** — same coupling, same targeted-fixture pattern.

Accepted trade-off: these two tiers can still *see* seed rows (they
already scope their assertions) and a crash mid-suite can leave fixture
rows behind (`npx prisma db seed` restores a pristine playground).

## 4. Implementation steps

1. `.env` (and `.env.example` if added later): `DATABASE_URL_TEST`.
2. `vitest.config.ts`: convert to `projects: [{ name: 'unit', … }, { name: 'integration', … }]`,
   sharing the current alias/coverage settings; unit project gets
   `env.DATABASE_URL` override + `globalSetup`.
3. `tests/setup/unit-db.ts`: create-if-missing + `migrate deploy` +
   safety assertion (≈30 lines, uses `pg` via Prisma's raw driver or
   `child_process` → `npx prisma migrate deploy`).
4. Docs: note in `docs/technical-architecture.md` testing section;
   README quick-start unchanged (setup is automatic).
5. Verify: `npm test` twice locally (second run proves idempotency),
   then reseed dev and confirm the seed's future classes stay untouched
   after a full unit run.

## 5. Future extension (not now)

Full isolation of integration + e2e would require booting a second app
instance bound to the test database (e.g. `PORT=3100
DATABASE_URL=$DATABASE_URL_TEST next start`) from a global setup, and
pointing `BASE_URL`/Playwright at it. That buys complete separation at
the cost of a server boot per run and double-resident memory — worth it
only if targeted fixtures on the dev database ever cause real pain.
