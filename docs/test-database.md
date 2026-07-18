# Spec: dedicated test database for vitest

Status: **proposed** · Owner: dev · Scope: local development (CI unchanged)

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
3. Zero changes to CI (its database is already throwaway).
4. Zero extra steps in the daily loop — no manual database creation, no
   separate migrate command to remember.

**Non-goals**

- Isolating **Playwright e2e** or the **integration tests** from the dev
  server. Both talk to the app on `:3000`, and that app reads the dev
  database; pointing their fixtures elsewhere would break them. See §5.
- Per-test-file database isolation or transactional rollbacks (heavier
  machinery than this codebase needs; `fileParallelism: false` already
  serializes suites).

## 3. Design

### 3.1 Two vitest projects

Vitest 4's `projects` config splits the suite by blast radius:

| Project | Files | Database |
|---|---|---|
| `unit` | `src/**/*.test.ts` (17 files: services + lib) | **`ethical_yoga_test`** |
| `integration` | `tests/integration/**/*.test.ts` (4 files) | dev `ethical_yoga` (unchanged — must match the running app) |

`npx vitest run` still runs everything; `--project unit` selects one tier.
The dangerous tests — everything that instantiates a bare `PrismaClient`
and calls services with injected clocks — are all in the `unit` project.

### 3.2 URL convention

- `.env` gains `DATABASE_URL_TEST` (same Postgres server, database
  `ethical_yoga_test`).
- `vitest.config.ts` loads `.env` and sets
  `env.DATABASE_URL = DATABASE_URL_TEST ?? DATABASE_URL` **for the unit
  project only**. Fallback = current behavior, which is what CI wants
  (one throwaway database for everything) — CI needs no edits.
- Safety assertion in global setup: if `DATABASE_URL_TEST` is set, it
  must differ from `DATABASE_URL`; refuse to run otherwise (a typo must
  not silently reintroduce the shared-database hazard).

### 3.3 Provisioning + migrations (global setup)

A `tests/setup/unit-db.ts` vitest `globalSetup` for the unit project:

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
