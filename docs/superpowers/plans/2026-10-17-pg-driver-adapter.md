# Prisma 6 on the pg driver adapter and the client engine — implementation plan (#885)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every runtime reaches Postgres through `@prisma/adapter-pg` with `engineType = "client"`. Every DB-error matcher reads structured fields through one extractor, `src/lib/pg-error.ts`, and nothing reads the Rust engine's framing.

**Architecture:** One extractor (`pgErrorOf`, `isPgPoolTimeout`, `adapterKindOf`) knows where the adapter puts Postgres's fields. Every matcher, the transient classifier and the log serializer consume it. Pool policy moves from URL parameters into `createPrismaClient`'s options (`poolMax`, `connectionTimeoutMs`), built by an exported, unit-testable `poolConfigFor`. `isUniqueConflictOn` takes compiler-checked constraint names. The ceiling tests switch from `54001` to bound-parameter counts. The CI probes assert errno codes measured on locally built images.

**Tech Stack:** Prisma 6.19.3 (`prisma-client` generator, `engineType = "client"`), `@prisma/adapter-pg` 6.19.3, `pg` 8.23.1, Next 16.4.0 standalone, vitest (`unit`, `components`, `unit-sweeps`, `integration`), Playwright, Docker (`runner` and `migrate` targets).

**Spec:** `docs/superpowers/specs/2026-10-17-pg-driver-adapter-design.md`. It is the binding authority. Section and decision references below (§N, Dn) are to it. Read §3 (the shapes), §4 and §7 before any task.

Evidence and scratch scripts live in the session scratchpad. Every task refers to that folder as `$S`:

```bash
export S=/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/8ca55306-135e-4f05-ad44-1a1c25b9147f/scratchpad/885
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
cd /Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-885
```

Measurements the plan says to record go in `$S/measurements.md`, one heading per item, with the command and its output. The PR body and the docs named below quote from it. `$S/red-ledger.tsv` and `$S/red-ledger.md` are the red-window ledger (Task 4). None of these files is committed.

This plan and the spec are committed before Task 0 (the orchestrator does this), so the tree is clean when Task 0 starts.

---

## Spec defects found while planning

None blocks the design. Each is resolved inside the plan as stated, and the PR body names them.

1. **D3's table puts `Account_email_key` in teacher-profile's `isSessionCollision`.** The session branch passes a scalar `accountId` and writes no `Account` row (`src/app/api/account/teacher-profile/route.ts:130-132`), so `Account_email_key` cannot arise there. That contradicts the spec's own student-profile row, which makes `Account_email_key` conditional on the session path being able to create an `Account`. Resolution: Task 7 applies the spec's per-site verdict rule (D3: "every unique collision each `try` block can raise ... is either named ... or deliberately left"). The session path names `Teacher_account_live_unique`, `Teacher_email_key` and `Teacher_pageSlug_key`.
2. **D2's `adapterKindOf` re-derivation command over-matches.** `grep -n "kind: '" node_modules/@prisma/client/runtime/client.d.ts` also prints `kind: 'batch'` and `kind: 'itx'` from unrelated types. The docs carry a block-limited command instead: `sed -n '/^declare type MappedError = {/,/^};/p' node_modules/@prisma/client/runtime/client.d.ts | grep -oE "kind: '[A-Za-z]+'"`. The spec also says the set "cannot be tethered by the compiler". That is true, but a test can tether it, so Task 1 adds a unit test that reads that same block and compares it with `ADAPTER_KINDS` minus `mysql`, `sqlite` and `mssql`. This is an addition, not a change of design.
3. **§7's fabrication helper has no pool-timeout constructor.** The `P2024` fabrications (Task 8 lists them) must become pg-pool's plain `Error`, and §7 requires every fabrication to go through `tests/adapter-errors.ts`. Task 1 adds a fourth export, `pgPoolTimeout()`. Task 8 holds it to a produced pool timeout.
4. **§4 D3's list of test call sites omits `tests/integration/erased-profile-restart.test.ts:167`.** That line is a comment, counted in §11's 28, and it describes column matching, which stops being true. Task 7 rewrites it.
5. **§11's "18 `isUniqueConflictOn` call lines" counts the definition.** `git grep -n "isUniqueConflictOn(err" -- src ':!*.test.ts'` prints 18 lines, and one of them is the definition at `src/lib/unique-conflict.ts:66`. There are 17 call lines carrying 18 calls (`student-profile/route.ts:168` holds two). The spec's per-file breakdown ("student-profile 3") is off by the same one. Re-derive with `git grep -o "isUniqueConflictOn(err" -- src ':!*.test.ts' ':!src/lib/unique-conflict.ts' | wc -l`, which gives 18 calls; run it with `-n` instead of `-o` and it gives 17 lines. The PR body uses "18 calls on 17 lines", and the spec carries the corrected count.

**Unverified spec claims the plan measures before relying on them:**

- **D11: "Unpaged, the same read sends `3 * CEILING_ROWS + 1`" for every per-site test.** That holds only for a site whose deepest load is composite. Task 5 Step 1 measures each site's page-sized and unpaged peak first, with one mutation that un-pages every site at once. The remedy for a site whose unpaged peak is not above `3 * SWEEP_PAGE_SIZE + 1` is decided in advance: that site asserts its own bound, `k × SWEEP_PAGE_SIZE + c`, where `k` is its measured parameters per parent and `c` its measured constant, and its unpaged peak must exceed that bound. This departs from the spec's single bound, so it is recorded in the PR body for the spec owner, who can overrule it.
- **§7's factory case "`connectionTimeoutMs: 500` against `203.0.113.1` fails in under 2 s".** It has been measured on macOS only. The test runs in CI's ordinary `unit` job, so the PR's first CI run confirms it on `ubuntu-latest`.

---

## Global Constraints

- **Versions.** Prisma stays **6.19.3**. `@prisma/adapter-pg` is pinned **exactly `6.19.3`**; `pg` is `^8.23.1` and `@types/pg` is `^8.23.1` (dev). The dependency diff is already in the worktree, and Task 0 commits it.
- **Generator block.** `engineType = "client"` is added. Nothing else in the generator block changes, and there are no `previewFeatures`.
- **Factory.** `createPrismaClient` never passes `datasources` or `datasourceUrl`; the adapter takes the connection string.
- **Pool defaults, exactly:**
  - `max = os.availableParallelism() * 2 + 1`
  - `connectionTimeoutMillis = 10000`
  - `idleTimeoutMillis = 300000`, fixed
  - `allowExitOnIdle = true`, fixed
  - An empty or missing URL throws `createPrismaClient: no url given and DATABASE_URL is not set`.
  - A `poolMax` that is not a positive integer throws `RangeError`.
- **SQLSTATE source.** The SQLSTATE always comes from the adapter's `originalCode`; there is no `code` fallback anywhere. No matcher reads Prisma's or the engine's framing. The constraint names for `23505`, `23514` and `23P01` come from anchored clauses on `originalMessage`; the `23503` name comes from `cause.constraint.index`.
- **Imports.** `DriverAdapterError` is identified by `name`, never by import. Only `src/lib/prisma-client.ts` may import `pg`, `pg/*` or `@prisma/adapter-pg` (lint-enforced from Task 2).
- **Transient mapping.** `P2034 → serialization`, and pool exhaustion is `isPgPoolTimeout` → `pool_exhausted` at `error`; both land in Task 3. `P2024` is removed from every map in Task 8.
- **Test-first.** Write the failing test, watch it fail with the expected message, implement, then watch it pass.
- **Prove every guard bites** (solve-issue §3). For each guard named in a task's "Guard bites" step: break it exactly as stated, run the covering test, and paste the **exact** failure text into the task report. Then restore it and re-run green. A bite whose failure text differs from the expected one is reported, not glossed over.
- **Warm routes before scoring a mutation that integration tests judge.** `next dev` recompiles lazily, so after each mutation and after each restore, `curl` the touched route on the worktree app before reading RED or GREEN.
- **Comment Discipline (CLAUDE.md).** A comment annotates its own code. Wider facts go in `docs/technical-architecture.md` ("Database errors", "Where Prisma comes from") with a link: shapes, counts, pool numbers, which paths raise what. No counts or rosters in comments, and no "previously" history.
- **Counts** go in the PR body or `docs/`, each with the command that re-derives it. A grep piped through `head` or `tail` is not a count.
- **Migrations.** Never edit an applied migration. This change adds no migration.
- **Staging.** Stage exact paths. Quote paths with brackets or parentheses (`'src/app/api/rooms/[id]/route.ts'`). Never `git add -A` or `git add .`.
- **Never touch :3000.** Integration and e2e run against the worktree's own app, started with `pnpm run worktree:up` (after `pnpm install --frozen-lockfile` and a one-time `pnpm run worktree:setup`). Whenever the generated client or route code changes, restart the **worktree's** app with `pnpm run worktree:down && pnpm run worktree:up`. A standalone server started locally uses `PORT=3998`.
- **Integration file lists below come from the census.** In the window (Tasks 4–9), the red ledger is authoritative, not the lists.
- **Commits** use a conventional prefix and end with `(#885)`, followed by the attribution lines the session supplies.

## Review Focus

Five input classes the spec implies but no spec-listed test exercises, most likely first. Each has its pinning test or sweep in the owning task.

1. **A session-path double-tap on the profile routes.** A twin request writes the same `accountId` **and** the same email. Postgres reports the first unique index it checks, in index-OID order. A committed duplicate measured on the dev DB reported `Student_email_key` / `Teacher_email_key`, and the OIDs put the email key before `*_account_live_unique` (`SELECT indexrelid::regclass FROM pg_index WHERE indrelid = '"Student"'::regclass ORDER BY indexrelid`). So the double-tap reports the email key. A twin on the same account with a different email reports `*_account_live_unique`. Both must answer the route's non-500 answer. Task 7 produces each one behind a held, uncommitted twin.
2. **Free text that quotes a constraint clause.** A teacher's template name or a trigger's own message can contain `violates check constraint "X"` mid-sentence. The anchored clauses must not match it. Task 1 adds fabricated impostor cases.
3. **A `tsx` script or vitest worker that ends without `$disconnect()`.** It must exit promptly, not after the 300 s idle timeout. Task 4 adds a child-process test: one query, no disconnect, and the process exits in under 5 s. The test kills its child if it lingers.
4. **`$queryRaw` that selects a `name` or `char` column on a production path no test reaches.** That is `P2010` `UnsupportedNativeDataType`, which surfaces as a 500. Task 11 sweeps every non-test raw query and gives each a verdict.
5. **An unbounded `in:` list or composite relation load past the bind limit.** That fails with `08P01`, which surfaces as a 500. Task 11 sweeps the `in:` arguments, with a verdict on each one's largest realistic size.

---

## Task order and the red window

```
0 → 1 → 2 → 3 (all green, pre-switch)
  → 4 (switch: opens the window) → 5 → 6 → 7 → 8 → 9 (closes it: full suite green)
  → 10 → 11 → 12 → 13 (after the push; orchestrator)
```

Tasks 0–3 are green. Task 0 comes first, because it commits the dependencies the others use. Tasks 1, 2 and 3 run in that order, because 3 consumes 1's extractor and helper.

**Task 3 moves the shape-independent halves out of the window.** Each of these is additive and green on the library engine, tested with fabricated errors through `tests/adapter-errors.ts`:

- In the serializer: withhold `DriverAdapterError` by name, never walk its plain-object cause, widen the code rule, and add `timeTaken` to `META_KEYS`.
- In the transient classifier: map `isPgPoolTimeout` to `pool_exhausted`, and `P2034` to `serialization` (on the library engine a typed `40001` is `P2034` too, so D5's measurement holds there).

This also keeps §2 item 3's log leak out of every red-window commit. There is no library-engine-plus-adapter stage: that configuration has the 6.19.3 `SocketTimeout` deserialisation bug, and it proves nothing about v7 (§2 item 1).

**Tasks 4–9 are a declared red window, and they run strictly in the order 4 → 5 → 6 → 7 → 8 → 9, one at a time, in this one worktree.** The switch cannot be split with a green suite in between, for three reasons:

- `engineType = "client"` is one generator setting for every runtime, and the client engine refuses to start without an adapter (P2038, §2 item 1). Turning it on changes every real DB error's shape at once.
- The matchers read only the C+A shape (D1). A name-keyed `isUniqueConflictOn` cannot work before the switch, because on the library engine a typed `P2002`'s message carries no constraint name.
- Doing it all in one task means one diff holding the switch, every matcher rewrite and roughly 60 test files, which no single reviewer can gate.

Task 4 flips the engine and writes the ledger. Tasks 5–9 each turn one category green.

The window tasks share files, which is one more reason they are sequential:

| File | Tasks |
|---|---|
| `src/lib/api-errors.ts` | 3, 6, 7, 8 |
| `src/lib/api-errors.test.ts` | 3, 6, 7, 8 |
| `src/lib/log-serializers.ts` and its test | 3, 9 |
| `src/lib/pg-error.test.ts` | 1, 6, 7, 9 |
| `src/app/api/rooms/[id]/route.ts` | 6 (`:82` docblock), 7 (`:214` call) |
| `src/services/schedule-rule-constraints.test.ts` | 6, 7 |
| `src/app/api/registrations/route.test.ts` | 7, 8 |
| `vitest.tiers.ts` | 7, 8 |
| `docs/technical-architecture.md` | 1, 4, 5, 8, 10 |

**Ledger rules (Task 4 writes them; every window task obeys them):**

- **Category.** Every red test row gets one of **K** ceiling (Task 5), **C** conflict codes (Task 6), **U** unique names and the P2002 fallback's `detail` (Task 7), **T** transient kinds (Task 8), or **S** serializer (Task 9).
- **Tie-break.** A row belongs to the **latest** task whose change it needs. An `it` holding assertions from two categories is split into two `it`s when the ledger is written, so each half has one owner.
- **Uncategorised rows.** A red row outside every category is Task 4's. It is fixed there: by a `::text` cast, by a `SELECT 1` in place of a timing-relevant `$connect()`, or by rewriting it to the C+A shape with a verdict in the ledger. If none of those works, stop and report.
- **Fabricated tests.** A test that fabricates an old shape is still green at Task 4, because the old matchers still read the old shape. It goes red in the task that rewrites its matcher, and **that task owns rewriting it**. Each window task's Files block lists those files from the census.

**The window gate.** This is the last step of every window task (5–9), and the end of Task 4 after the ledger:

```bash
pnpm run worktree:down && pnpm run worktree:up
pnpm exec vitest run --project unit --project components --reporter=default --reporter=json --outputFile.json=$S/run-tN-a.json || true
pnpm exec vitest run --project unit-sweeps --project integration --reporter=default --reporter=json --outputFile.json=$S/run-tN-b.json || true
for f in $S/run-tN-a.json $S/run-tN-b.json; do
  node -e 'const r=require(process.argv[1]);for(const f of r.testResults)for(const a of f.assertionResults)if(a.status==="failed")console.log(require("path").relative(process.cwd(),f.name)+"\t"+a.fullName)' "$f"
done | sort > $S/red-tN.tsv
comm -13 <(cut -f1,2 $S/red-ledger.tsv | sort) $S/red-tN.tsv     # NEW red rows: must print nothing
grep -P "\t<this task's category>$" $S/red-ledger.tsv | cut -f1,2 | sort | comm -12 - $S/red-tN.tsv   # own rows still red: must print nothing
```

Run the two vitest invocations separately, never `pnpm test`: its `&&` would hide the second half behind a red first half. `N` is the task number. A new red row is the current task's to fix before committing. Each red-window commit body carries one line: `Suite red by design (red window, plan Tasks 4-9): <categories still red>.` A bisect across Tasks 4–8 skips those commits, and the PR body says so.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/pg-error.ts` (new) | The one place that knows where the adapter puts Postgres's fields: `pgErrorOf`, `isPgPoolTimeout`, `adapterKindOf`, `ADAPTER_KINDS` | 1 |
| `src/lib/pg-error.test.ts` (new) | Fabricated branch tests (1); real-DB conflict matrix, 23505 cases, registry, fidelity (6, 7); serializer facet `it`s (9) | 1, 6, 7, 9 |
| `src/lib/pg-error-sites.test.ts` (new, serial) | Produced collisions at the local-net sites, behind held uncommitted twins | 7 |
| `tests/holder-race.ts` (new) | `latch`, `ownPid`, `waiterOf`, `raceBehindHolder`, extracted from `teacher-profile/route-lock-order.test.ts` and made generic | 7 |
| `tests/adapter-errors.ts` (new) | The only fabrication helper: `driverAdapterError`, `knownWithAdapterCause`, `pgCause`, `pgPoolTimeout` | 1 |
| `src/lib/prisma-client.ts` | Factory options, `poolConfigFor`, `DEFAULT_POOL_MAX`, adapter wiring | 2, 4 |
| `src/lib/prisma-client.test.ts` | Pool policy pins, funnel pins, version tether, factory behaviour | 2, 4 |
| `eslint.config.mjs` | `pg` / `@prisma/adapter-pg` import ban outside the funnel | 2 |
| `src/lib/log-serializers.ts` | Shape-independent half (3); facet lifting and removals (9) | 3, 9 |
| `src/lib/api-errors.ts` | `P2034`/pool-timeout mapping (3); terminal and restrict (6); P2002 `detail` (7); structured SQLSTATE read and `P2024` removal (8) | 3, 6, 7, 8 |
| `prisma/schema.prisma` | `engineType = "client"` | 4 |
| `tests/stack-ceiling.ts`, `src/services/sweep-page-ceiling.test.ts`, `src/lib/read-in-pages.ts` (docblock) | D11 re-base | 4 (startup option), 5 |
| `src/lib/check-violation.ts`, `src/lib/exclusion-conflict.ts`, `src/services/payout-notice.ts` | Conflict matchers on `pgErrorOf` | 6 |
| `src/lib/unique-conflict.ts` + the 17 call lines + 4 `rawTarget` logs | D3 | 7 |
| `src/lib/db-transient-shapes.test.ts` (new, serial) | Produced transient matrix | 8 |
| `scripts/prisma-client-probe.cjs` (renamed), `scripts/check-reserved-slugs.ts`, `.github/workflows/ci.yml`, `Dockerfile` (comment) | D7 | 10 |
| `docs/technical-architecture.md`, `docs/supply-chain.md`, `docs/data-model.md`, `docs/lock-order.md` | Rewritten where this change makes them false | each owning task |

---

### Task 0: Baseline measurements and the dependency commit

**Files:**
- Commit: `package.json`, `pnpm-lock.yaml` (already modified in the worktree)
- Write (uncommitted): `$S/measurements.md`

**Interfaces:** none in code. Produces the "before" numbers that Task 12 compares against.

- [ ] **Step 1: Confirm the tree and the dependency diff**

Run: `git status --short` and `git diff package.json`
Expected:
- Only `package.json` and `pnpm-lock.yaml` are modified. The plan and spec are already committed.
- The diff adds `"@prisma/adapter-pg": "6.19.3"` (exact, no caret), `"pg": "^8.23.1"`, and the devDependency `"@types/pg": "^8.23.1"`.

- [ ] **Step 2: Install and verify the lockfile**

Run: `pnpm install --frozen-lockfile && pnpm run check-lockfile`
Expected: both exit 0.

- [ ] **Step 3: Build both images on the pre-switch tree and record their sizes**

```bash
docker build -t fairyoga:885-before .
docker build --target migrate -t fairyoga-migrate:885-before .
docker image inspect -f '{{.Size}}' fairyoga:885-before fairyoga-migrate:885-before
```
Record both byte counts under "§6 item 7, before" in `$S/measurements.md`. `pg` is installed but unused at this point. The migrate image (`FROM deps`) already carries it; the runner image does not.

- [ ] **Step 4: Record the runner's idle RSS before**

```bash
DB_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | sed 's/localhost/host.docker.internal/')"
docker run -d --name fy885-before -e DATABASE_URL="$DB_URL" -e PORT=3998 -p 3998:3998 fairyoga:885-before
sleep 8; curl -s http://127.0.0.1:3998/api/health; echo
docker stats --no-stream --format '{{.MemUsage}}' fy885-before
docker rm -f fy885-before
```
Expected: health prints `{"status":"ok","db":"up"}`. Record the `MemUsage` figure.

- [ ] **Step 5: Record the e2e and vitest wall times before**

```bash
pnpm run worktree:up
/usr/bin/time -p pnpm exec playwright test 2>&1 | tail -n 5
/usr/bin/time -p pnpm test 2>&1 | tail -n 5
```
Record the `real` lines and the pass/fail summary. Here `tail` only trims output for the record; it counts nothing. Both suites must be green on this tree. If either is red before any change, stop: the baseline is not a baseline.

- [ ] **Step 6: Commit the dependencies**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @prisma/adapter-pg, pg and @types/pg (#885)"
```

---

### Task 1: The extractor `src/lib/pg-error.ts` and the fabrication helper

**Files:**
- Create: `src/lib/pg-error.ts`
- Create: `tests/adapter-errors.ts`
- Create: `src/lib/pg-error.test.ts` (fabricated cases only; Tasks 6, 7 and 9 add to it)
- Modify: `docs/technical-architecture.md` (new subsection "Database errors" under the Database section)

**Interfaces:**
- Produces (exact):
  ```ts
  // src/lib/pg-error.ts
  export interface PgError { readonly sqlState: string; readonly message: string; readonly constraint?: string }
  export const ADAPTER_KINDS: readonly [...];           // see code below
  export type AdapterKind = (typeof ADAPTER_KINDS)[number];
  export const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
  export function pgErrorOf(err: unknown): PgError | null;
  export function isPgPoolTimeout(err: unknown): boolean;
  export function adapterKindOf(err: unknown): AdapterKind | undefined;

  // tests/adapter-errors.ts
  export interface AdapterCause { readonly kind: string; readonly [key: string]: unknown }
  export function pgCause(sqlState: string, message: string, extra?: Partial<AdapterCause>): AdapterCause;
  export function driverAdapterError(cause: AdapterCause): Error;
  export function knownWithAdapterCause(code: string, cause: AdapterCause, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError;
  export function pgPoolTimeout(): Error;
  ```

- [ ] **Step 1: Write the failing tests** in `src/lib/pg-error.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Prisma } from '@/lib/prisma-client';
import { ADAPTER_KINDS, adapterKindOf, isPgPoolTimeout, pgErrorOf } from './pg-error';
import { driverAdapterError, knownWithAdapterCause, pgCause, pgPoolTimeout } from '../../tests/adapter-errors';

describe('pgErrorOf (fabricated branches)', () => {
  it('reads a typed DriverAdapterError from its own cause', () => {
    const err = driverAdapterError(pgCause('23514', 'Class abc is completed, which is terminal; cannot change status to open'));
    expect(pgErrorOf(err)).toEqual({ sqlState: '23514', message: 'Class abc is completed, which is terminal; cannot change status to open' });
  });

  it('reads a Known error from meta.driverAdapterError.cause', () => {
    const err = knownWithAdapterCause('P2010', pgCause('55P03', 'canceling statement due to lock timeout'));
    expect(pgErrorOf(err)).toEqual({ sqlState: '55P03', message: 'canceling statement due to lock timeout' });
  });

  it('takes the SQLSTATE from originalCode even where code is absent (40001)', () => {
    const err = knownWithAdapterCause('P2034', pgCause('40001', 'could not serialize access due to concurrent update'));
    expect(pgErrorOf(err)?.sqlState).toBe('40001');
  });

  it.each([
    ['23505', 'duplicate key value violates unique constraint "Teacher_pageSlug_key"', 'Teacher_pageSlug_key'],
    ['23514', 'new row for relation "Class" violates check constraint "Class_live_needs_open_room"', 'Class_live_needs_open_room'],
    ['23P01', 'conflicting key value violates exclusion constraint "CalendarEntry_teacher_slot_excl"', 'CalendarEntry_teacher_slot_excl'],
  ])('names the constraint for %s from the anchored clause', (sqlState, message, name) => {
    expect(pgErrorOf(driverAdapterError(pgCause(sqlState, message)))?.constraint).toBe(name);
  });

  it('names a 23503 constraint from cause.constraint.index only', () => {
    const withIndex = knownWithAdapterCause('P2003', pgCause('23503', 'update or delete on table "TeacherRoom" violates foreign key constraint "Class_teacherRoomId_roomArchived_fkey" on table "Class"', { constraint: { index: 'Class_teacherRoomId_roomArchived_fkey' } }));
    expect(pgErrorOf(withIndex)?.constraint).toBe('Class_teacherRoomId_roomArchived_fkey');
    const fieldsOnly = knownWithAdapterCause('P2003', pgCause('23503', 'insert or update on table "TeacherRoom" violates foreign key constraint "TeacherRoom_roomId_fkey"', { constraint: { fields: ['roomId'] } }));
    expect(pgErrorOf(fieldsOnly)?.constraint).toBeUndefined();
  });

  // Review Focus 2: free text quoting a clause never names a constraint.
  it.each([
    ['23514', 'Class abc is completed, which is terminal; note: violates check constraint "Class_live_needs_open_room" in text'],
    ['23514', 'trigger said: new row violates check constraint "X" and more'],
    ['23505', 'note: duplicate key value violates unique constraint "Teacher_pageSlug_key"'],
    ['23P01', 'conflicting key value violates exclusion constraint "A" "B"'],
  ])('does not name a constraint from an impostor %s message', (sqlState, message) => {
    expect(pgErrorOf(driverAdapterError(pgCause(sqlState, message)))?.constraint).toBeUndefined();
  });

  it.each([
    ['no cause', Object.assign(new Error('x'), { name: 'DriverAdapterError' })],
    ['a non-Error impostor', { name: 'DriverAdapterError', cause: pgCause('23514', 'm') }],
    ['an Unknown request error', new Prisma.PrismaClientUnknownRequestError('code: "23514"', { clientVersion: '6.19.3' })],
    ['a Known error without driverAdapterError', new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '6.19.3', meta: { target: ['email'] } })],
    ['a lowercase SQLSTATE', driverAdapterError(pgCause('2351x', 'm'))],
    ['a missing originalMessage', driverAdapterError({ kind: 'postgres', originalCode: '23514' })],
    ['a kind with no Postgres error', knownWithAdapterCause('P2010', { kind: 'DatabaseNotReachable', host: 'h', port: 1 })],
  ])('answers null for %s', (_label, err) => {
    expect(pgErrorOf(err)).toBeNull();
  });

  it('is shallow: it never follows Error.cause', () => {
    const inner = driverAdapterError(pgCause('55P03', 'lock timeout'));
    expect(pgErrorOf(new Error('outer', { cause: inner }))).toBeNull();
  });
});

describe('isPgPoolTimeout', () => {
  it('matches pg-pool\'s plain timeout error', () => {
    expect(isPgPoolTimeout(pgPoolTimeout())).toBe(true);
  });
  it.each([
    ['a different message', Object.assign(new Error('timeout exceeded when trying to connect.'), { clientVersion: '6.19.3' })],
    ['an own code', Object.assign(pgPoolTimeout(), { code: 'ETIMEDOUT' })],
    ['a non-Error', { message: 'timeout exceeded when trying to connect' }],
  ])('rejects %s', (_label, err) => {
    expect(isPgPoolTimeout(err)).toBe(false);
  });
});

describe('adapterKindOf', () => {
  it('reads cause.kind from either path, inside the closed set', () => {
    expect(adapterKindOf(knownWithAdapterCause('P2010', { kind: 'DatabaseNotReachable', host: 'h', port: 1 }))).toBe('DatabaseNotReachable');
    expect(adapterKindOf(driverAdapterError(pgCause('23514', 'm')))).toBe('postgres');
  });
  it('answers undefined for a kind outside the set', () => {
    expect(adapterKindOf(knownWithAdapterCause('P2010', { kind: 'mysql' }))).toBeUndefined();
    expect(adapterKindOf(knownWithAdapterCause('P2010', { kind: 'constructor' }))).toBeUndefined();
  });
  it('ADAPTER_KINDS is MappedError\'s kinds minus the other databases\'', () => {
    const dts = readFileSync(path.join(process.cwd(), 'node_modules/@prisma/client/runtime/client.d.ts'), 'utf8');
    const start = dts.indexOf('declare type MappedError = {');
    const end = dts.indexOf('\n};', start);
    expect(start).toBeGreaterThan(-1);
    const kinds = [...dts.slice(start, end).matchAll(/kind: '([A-Za-z]+)'/g)].map((m) => m[1]);
    const expected = kinds.filter((k) => k !== 'mysql' && k !== 'sqlite' && k !== 'mssql');
    expect([...ADAPTER_KINDS].sort()).toEqual([...expected].sort());
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts`
Expected: FAIL with `Failed to resolve import "./pg-error"`.

- [ ] **Step 3: Write `tests/adapter-errors.ts`**

```ts
import { Prisma } from '@/lib/prisma-client';
import { PG_POOL_TIMEOUT_MESSAGE } from '@/lib/pg-error';

/** The plain object the pg driver adapter puts in a DriverAdapterError's `cause`. */
export interface AdapterCause {
  readonly kind: string;
  readonly [key: string]: unknown;
}

const CLIENT_VERSION = Prisma.prismaVersion.client;

/**
 * The cause the adapter builds for a pg `DatabaseError` with this SQLSTATE:
 * the kind and the fields it sets per code. The fidelity tests in
 * `src/lib/pg-error.test.ts` and `src/lib/db-transient-shapes.test.ts` hold
 * each shape to a produced one.
 */
export function pgCause(sqlState: string, message: string, extra: Partial<AdapterCause> = {}): AdapterCause {
  const original = { originalCode: sqlState, originalMessage: message };
  switch (sqlState) {
    case '23505':
      return { ...original, kind: 'UniqueConstraintViolation', ...extra };
    case '23503':
      return { ...original, kind: 'ForeignKeyConstraintViolation', ...extra };
    case '40001':
      return { ...original, kind: 'TransactionWriteConflict', ...extra };
    default:
      return { ...original, kind: 'postgres', code: sqlState, severity: 'ERROR', message, detail: undefined, column: undefined, hint: undefined, ...extra };
  }
}

/** A typed call's shape: a DriverAdapterError whose `cause` is the adapter's object. */
export function driverAdapterError(cause: AdapterCause): Error {
  const message = typeof cause.message === 'string' ? cause.message : cause.kind;
  const err = new Error(message);
  Object.defineProperty(err, 'name', { value: 'DriverAdapterError', enumerable: true, writable: true, configurable: true });
  Object.defineProperty(err, 'cause', { value: cause, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(err, 'clientVersion', { value: CLIENT_VERSION, enumerable: true, writable: true, configurable: true });
  return err;
}

/** A raw or mapped call's shape: a Known error carrying the adapter's error in `meta`. */
export function knownWithAdapterCause(
  code: string,
  cause: AdapterCause,
  meta: Record<string, unknown> = {},
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`fabricated ${code}`, {
    code,
    clientVersion: CLIENT_VERSION,
    meta: { ...meta, driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

/** pg-pool's wait-timeout error as Prisma rethrows it: a plain Error, own key `clientVersion` only. */
export function pgPoolTimeout(): Error {
  return Object.assign(new Error(PG_POOL_TIMEOUT_MESSAGE), { clientVersion: CLIENT_VERSION });
}
```

The own-key details are provisional: which keys exist, and whether they are enumerable. The fidelity tests in Tasks 6 and 8 compare them against produced errors. The helper is adjusted to what those tests measure, never the other way round.

- [ ] **Step 4: Write `src/lib/pg-error.ts`**

```ts
import { Prisma } from '@/lib/prisma-client';

/**
 * A Postgres error as the pg driver adapter reports it: only fields Postgres
 * wrote. Where each field comes from, and why the 23505/23514/23P01 names
 * are read from the primary message: `docs/technical-architecture.md`,
 * "Database errors".
 */
export interface PgError {
  /** The SQLSTATE: the adapter's `originalCode`, which is pg's `DatabaseError.code`. */
  readonly sqlState: string;
  /** Postgres's primary message: the adapter's `originalMessage`. Never logged verbatim. */
  readonly message: string;
  /** The violated constraint's name, for the SQLSTATEs in `CONSTRAINT_SOURCE` only. */
  readonly constraint?: string;
}

/** The adapter kinds this repo can meet; the test beside this file tethers it to the runtime's type. */
export const ADAPTER_KINDS = [
  'GenericJs', 'UnsupportedNativeDataType', 'InvalidIsolationLevel', 'LengthMismatch',
  'UniqueConstraintViolation', 'NullConstraintViolation', 'ForeignKeyConstraintViolation',
  'DatabaseNotReachable', 'DatabaseDoesNotExist', 'DatabaseAlreadyExists', 'DatabaseAccessDenied',
  'ConnectionClosed', 'TlsConnectionError', 'AuthenticationFailed', 'TransactionWriteConflict',
  'TableDoesNotExist', 'ColumnNotFound', 'TooManyConnections', 'ValueOutOfRange',
  'MissingFullTextSearchIndex', 'SocketTimeout', 'InconsistentColumnData',
  'TransactionAlreadyClosed', 'postgres',
] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];
const ADAPTER_KIND_SET: ReadonlySet<string> = new Set(ADAPTER_KINDS);

/** pg-pool's own text for a pool wait that outlived `connectionTimeoutMillis` (driver text, matched only here). */
export const PG_POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

const SQLSTATE = /^[0-9A-Z]{5}$/;

type ConstraintReader = (cause: object, message: string) => string | undefined;

function fromMessage(clause: RegExp): ConstraintReader {
  return (_cause, message) => clause.exec(message)?.[1];
}

function field(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** Where each constraint SQLSTATE's name comes from; a SQLSTATE added here must say. */
const CONSTRAINT_SOURCE = {
  '23503': (cause) => {
    const constraint = field(cause, 'constraint');
    const index = isObject(constraint) ? field(constraint, 'index') : undefined;
    return typeof index === 'string' ? index : undefined;
  },
  '23505': fromMessage(/^duplicate key value violates unique constraint "([^"]+)"$/),
  '23514': fromMessage(/ violates check constraint "([^"]+)"$/),
  '23P01': fromMessage(/^conflicting key value violates exclusion constraint "([^"]+)"$/),
} as const satisfies Record<'23503' | '23505' | '23514' | '23P01', ConstraintReader>;

function hasConstraintSource(sqlState: string): sqlState is keyof typeof CONSTRAINT_SOURCE {
  return Object.prototype.hasOwnProperty.call(CONSTRAINT_SOURCE, sqlState);
}

/** The adapter's cause object, from exactly one of the two places it is put; never walks `Error.cause`. */
function adapterCauseOf(err: unknown): object | null {
  if (err instanceof Error && err.name === 'DriverAdapterError') {
    const cause: unknown = err.cause;
    return isObject(cause) ? cause : null;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const wrapped = isObject(err.meta) ? field(err.meta, 'driverAdapterError') : undefined;
    if (!isObject(wrapped) || field(wrapped, 'name') !== 'DriverAdapterError') return null;
    const cause = field(wrapped, 'cause');
    return isObject(cause) ? cause : null;
  }
  return null;
}

export function pgErrorOf(err: unknown): PgError | null {
  const cause = adapterCauseOf(err);
  if (cause === null) return null;
  const sqlState = field(cause, 'originalCode');
  const message = field(cause, 'originalMessage');
  if (typeof sqlState !== 'string' || !SQLSTATE.test(sqlState) || typeof message !== 'string') return null;
  const constraint = hasConstraintSource(sqlState) ? CONSTRAINT_SOURCE[sqlState](cause, message) : undefined;
  return constraint === undefined ? { sqlState, message } : { sqlState, message, constraint };
}

export function isPgPoolTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message === PG_POOL_TIMEOUT_MESSAGE &&
    !Object.prototype.hasOwnProperty.call(err, 'code') &&
    pgErrorOf(err) === null
  );
}

export function adapterKindOf(err: unknown): AdapterKind | undefined {
  const cause = adapterCauseOf(err);
  const kind = cause === null ? undefined : field(cause, 'kind');
  return typeof kind === 'string' && ADAPTER_KIND_SET.has(kind) ? (kind as AdapterKind) : undefined;
}
```

Give `pgErrorOf`, `isPgPoolTimeout` and `adapterKindOf` docblocks of two to four lines each. Each states the contract from D2 and links "Database errors". None carries a shape table or a list of kinds.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts`
Expected: PASS. If the `ADAPTER_KINDS` tether fails, the runtime's list differs from the code above. Copy the runtime's list into the code, never the other way round.

- [ ] **Step 6: Guard bites** (on the fabricated tests; the real-DB bites are in Tasks 6 and 8)

| Break | Expected failure |
|---|---|
| `pgErrorOf` reads `field(cause, 'code')` instead of `originalCode` | the `40001` case and the 23505 / 23503 cases fail (`null` / `undefined`) |
| delete the `DriverAdapterError` branch of `adapterCauseOf` | every `driverAdapterError(...)` case fails |
| delete the Known branch | every `knownWithAdapterCause(...)` case fails |
| drop the `^` anchor on the 23505 clause | the "note: duplicate key ..." impostor case fails |
| drop the `$` anchor on the 23514 clause | the "trigger said: ... and more" impostor case fails |
| change one character of `PG_POOL_TIMEOUT_MESSAGE` | `matches pg-pool's plain timeout error` fails |
| add `'mysql'` to `ADAPTER_KINDS` | the tether test fails |

Record each exact failure text in the task report.

- [ ] **Step 7: Write the docs subsection**

In `docs/technical-architecture.md`, add "### Database errors" under the Database section. It carries, in order:
- the `pgErrorOf` contract: shallow; the two paths; `originalCode` and `originalMessage` required; kinds with no Postgres error answer `null`;
- §3's table of shapes, keeping "measured on C+A, Prisma 6.19.3" and the date;
- the `CONSTRAINT_SOURCE` table and the three clause patterns;
- the locale and Postgres-major assumption from §9 risk 1, with links to `src/lib/service-image-check.ts` and to `docs/supply-chain.md` "The database image", and the rule that a Postgres major bump moves production and CI together;
- `isPgPoolTimeout`'s literal, with its re-derivation `grep -n "timeout exceeded when trying to connect" node_modules/.pnpm/pg-pool@*/node_modules/pg-pool/index.js`;
- the `ADAPTER_KINDS` re-derivation (spec defect 2's command, minus `mysql`, `sqlite` and `mssql`).

Task 8 adds the `pool_exhausted` / `tx_budget` split.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/lib/pg-error.ts src/lib/pg-error.test.ts tests/adapter-errors.ts docs/technical-architecture.md
git commit -m "feat: one extractor for the pg driver adapter's Postgres errors (#885)"
```

---

### Task 2: Pool policy as a pure function, the import ban, the version tether

**Files:**
- Modify: `src/lib/prisma-client.ts`. Add the options interface, `DEFAULT_POOL_MAX`, `DEFAULT_CONNECTION_TIMEOUT_MS`, `PgPoolConfig` and `poolConfigFor`. **Do not wire them yet.** `createPrismaClient`'s body is untouched.
- Modify: `src/lib/prisma-client.test.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Produces (exact):
  ```ts
  export interface PrismaClientFactoryOptions {
    url?: string;
    poolMax?: number;
    connectionTimeoutMs?: number;
    errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
    log?: Prisma.PrismaClientOptions['log'];
  }
  export const DEFAULT_POOL_MAX: number;               // availableParallelism() * 2 + 1
  export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
  export interface PgPoolConfig {
    readonly connectionString: string; readonly max: number;
    readonly connectionTimeoutMillis: number; readonly idleTimeoutMillis: number;
    readonly allowExitOnIdle: boolean;
  }
  export function poolConfigFor(options?: PrismaClientFactoryOptions): PgPoolConfig;
  ```
- Consumed by Task 4, which wires them in and migrates every caller.

- [ ] **Step 1: Write the failing tests** (append to `src/lib/prisma-client.test.ts`)

```ts
import { availableParallelism } from 'node:os';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { poolConfigFor, DEFAULT_POOL_MAX } from './prisma-client';

describe('poolConfigFor', () => {
  it('fills every default from DATABASE_URL and the fixed policy', () => {
    expect(poolConfigFor({})).toEqual({
      connectionString: process.env.DATABASE_URL,
      max: availableParallelism() * 2 + 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 300000,
      allowExitOnIdle: true,
    });
    expect(DEFAULT_POOL_MAX).toBe(availableParallelism() * 2 + 1);
  });
  it('passes url, poolMax and connectionTimeoutMs through', () => {
    expect(poolConfigFor({ url: 'postgresql://a@b/c', poolMax: 1, connectionTimeoutMs: 200 }))
      .toMatchObject({ connectionString: 'postgresql://a@b/c', max: 1, connectionTimeoutMillis: 200 });
  });
  it('throws for an empty url, like a missing one', () => {
    expect(() => poolConfigFor({ url: '' })).toThrow('createPrismaClient: no url given and DATABASE_URL is not set');
  });
  it('throws for a missing url when DATABASE_URL is unset', () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => poolConfigFor({})).toThrow('createPrismaClient: no url given and DATABASE_URL is not set');
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
  it.each([0, -1, 1.5, Number.NaN])('refuses poolMax %s with a RangeError', (poolMax) => {
    expect(() => poolConfigFor({ poolMax })).toThrow(RangeError);
  });
});

describe('adapter version tether', () => {
  it('pins @prisma/adapter-pg to the generated client\'s version', () => {
    const req = createRequire(path.join(process.cwd(), 'package.json'));
    let dir = path.dirname(req.resolve('@prisma/adapter-pg'));
    let version: unknown;
    for (;;) {
      const candidate = path.join(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: unknown };
        if (pkg.name === '@prisma/adapter-pg') { version = pkg.version; break; }
      }
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('no package.json for @prisma/adapter-pg above its main entry');
      dir = parent;
    }
    expect(version).toBe(Prisma.prismaVersion.client);
  });
});
```

Change the funnel pin's name to "prisma-client.ts imports only the generated client, `@prisma/adapter-pg` and `node:os`", and its assertion to:
```ts
const ALLOWED = new Set(['../generated/prisma/client', '@prisma/adapter-pg', 'node:os']);
expect(specifiers.every((s) => ALLOWED.has(s))).toBe(true);
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts`
Expected: FAIL with `poolConfigFor is not a function` in every `poolConfigFor` case. The tether passes already, because it reads the installed dependency. Its bite comes in Step 5.

- [ ] **Step 3: Implement** in `src/lib/prisma-client.ts`

```ts
import { availableParallelism } from 'node:os';

/** pg's `max` when `poolMax` is omitted. Why this formula, and its production value: docs/technical-architecture.md, "Where Prisma comes from". */
export const DEFAULT_POOL_MAX = availableParallelism() * 2 + 1;
/** pg's `connectionTimeoutMillis` when `connectionTimeoutMs` is omitted. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
/** Keeps an idle connection, and a single-connection client's backend, for as long as Prisma's own pool did. */
const IDLE_TIMEOUT_MS = 300_000;

export interface PrismaClientFactoryOptions {
  /** Connection string. Omitted, `DATABASE_URL` is read when the client is built. */
  url?: string;
  /** pg's `max`. Omitted, `DEFAULT_POOL_MAX`. */
  poolMax?: number;
  /** pg's `connectionTimeoutMillis`: bounds both a pool wait and a new connection. */
  connectionTimeoutMs?: number;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
  /** Passed through; the ceiling tests count bound parameters from the query event. */
  log?: Prisma.PrismaClientOptions['log'];
}

/** The `pg.Pool` config `PrismaPg` is built from. */
export interface PgPoolConfig {
  readonly connectionString: string;
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
  readonly allowExitOnIdle: boolean;
}

/**
 * The pool `createPrismaClient` builds for `options`. An empty url counts as
 * missing: pg would read it as "libpq defaults" rather than refuse.
 * `allowExitOnIdle` unrefs idle clients so a finished process exits; it closes nothing.
 */
export function poolConfigFor(options: PrismaClientFactoryOptions = {}): PgPoolConfig {
  const connectionString = options.url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('createPrismaClient: no url given and DATABASE_URL is not set');
  const max = options.poolMax ?? DEFAULT_POOL_MAX;
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`createPrismaClient: poolMax must be a positive integer, got ${String(max)}`);
  }
  return {
    connectionString,
    max,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
  };
}
```

Leave `createPrismaClient`'s body exactly as it is: `url` goes to `datasources`, and the rest is spread into `new PrismaClient`. No caller passes `poolMax` or `connectionTimeoutMs` until Task 4 wires them. If one did, Prisma's constructor validation would refuse the unknown key. Do not destructure them out to silence anything. An unused destructured binding fails `@typescript-eslint/no-unused-vars` here, because the config sets only `argsIgnorePattern`.

- [ ] **Step 4: Add the lint ban** in `eslint.config.mjs`

Add a third pattern group to the existing `@typescript-eslint/no-restricted-imports` block, the one whose `ignores` is `['src/lib/prisma-client.ts', 'src/lib/prisma-enums.ts']`:
```js
{
  group: ['pg', 'pg/*', '@prisma/adapter-pg'],
  message: 'Only src/lib/prisma-client.ts builds a database pool; get a client from createPrismaClient (#885).',
},
```
Add one line to the block's comment: `prisma-enums.ts` is exempt here too, and its own funnel pin refuses any other import.

- [ ] **Step 5: Run green, then the guard bites**

Run: `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts && pnpm run lint`
Expected: PASS, and lint exits 0.

| Break | Expected failure |
|---|---|
| `connectionTimeoutMillis: 0` in `poolConfigFor` | `fills every default ...` fails on `connectionTimeoutMillis` |
| delete `allowExitOnIdle: true` | the same pin fails on `allowExitOnIdle` |
| `if (connectionString === undefined)` instead of the falsy test | `throws for an empty url ...` fails (no throw) |
| tether: assert against `'0.0.0'` | the tether test fails: `expected '6.19.3' to be '0.0.0'` |
| `import pg from 'pg';` at the top of `src/services/payments.ts` | `pnpm lint` fails with `Only src/lib/prisma-client.ts builds a database pool ...` |

Restore each break and re-run green. Record the failure texts.

- [ ] **Step 6: Commit**

```bash
pnpm run typecheck
git add src/lib/prisma-client.ts src/lib/prisma-client.test.ts eslint.config.mjs
git commit -m "feat: pool policy in the Prisma factory, pg imports confined to it (#885)"
```

---

### Task 3: The shape-independent halves, green before the switch

**Files:**
- Modify: `src/lib/log-serializers.ts`. Withhold `DriverAdapterError` by name. Never walk a withheld error's non-Error cause. Widen the withheld path's code rule. Add `timeTaken` to `META_KEYS`. Facet lifting and removals wait for Task 9.
- Modify: `src/lib/log-serializers.test.ts` (new fabricated cases only)
- Modify: `src/lib/api-errors.ts`. Add the `isPgPoolTimeout → pool_exhausted` arm in `transientKindShallow`, map `P2034 → serialization`, and rewrite the `TransientKind` and `TRANSIENT_KIND_LEVEL` docblocks (D5). `P2024` and the framing reads stay until Task 8.
- Modify: `src/lib/api-errors.test.ts` (the `P2034` cases, plus new `pgPoolTimeout()` cases)
- Modify: `docs/lock-order.md`. Add one sentence where `40001` is discussed (near `:1232`), saying which code paths can raise `40001` (D5): none in `src/` runs a repeatable-read or serializable transaction. Re-derive with `git grep -niE "isolationLevel|SERIALIZABLE|REPEATABLE READ" -- src ':!*.test.ts' ':!src/generated'`; only comments match today.

**Interfaces:**
- Consumes: `isPgPoolTimeout`, `driverAdapterError`, `knownWithAdapterCause`, `pgCause`, `pgPoolTimeout`.
- Produces: `TRANSIENT_PRISMA_CODE_KIND` becomes `{ P2024 → pool_exhausted, P2028 → tx_budget, P2034 → serialization }`, and Task 8 later removes `P2024`. The serializer's withheld set includes `DriverAdapterError`, and its withheld-path code rule is `WITHHELD_CODE = /^(?:P\d{4}|E[A-Z0-9_]{1,63})$/`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/api-errors.test.ts`:
- every existing `P2034` case now expects `{ kind: 'serialization', level: 'warn' }`;
- add:
```ts
it('classifies pg-pool\'s wait timeout as pool_exhausted at error', () => {
  expect(transientDbFailure(pgPoolTimeout())).toEqual({ kind: 'pool_exhausted', level: 'error' });
  expect(classifyApiError(pgPoolTimeout())).toMatchObject({ status: 503, detail: { transientKind: 'pool_exhausted' } });
});
it('finds a pool timeout one cause deep', () => {
  expect(transientDbFailure(new Error('wrapped', { cause: pgPoolTimeout() }))?.kind).toBe('pool_exhausted');
});
```

In `src/lib/log-serializers.test.ts`, add:
```ts
it('withholds a DriverAdapterError by name and does not walk its plain-object cause', () => {
  const err = driverAdapterError(pgCause('23514', 'Class 7e2b7875-c697-4dd0-bfdd-35a48d6fd186 is completed, which is terminal'));
  const out = serializeErr(err);
  expect(out).toMatchObject({ type: 'Error', name: 'DriverAdapterError', message: 'Driver adapter error (detail withheld from the log)' });
  expect(out).not.toHaveProperty('cause');
  expect(JSON.stringify(out)).not.toContain('7e2b7875');
});
it('still walks a real Error cause under a withheld error', () => {
  const err = knownWithAdapterCause('P2010', pgCause('55P03', 'm'));
  Object.defineProperty(err, 'cause', { value: new Error('inner'), enumerable: false });
  expect(serializeErr(err).cause).toMatchObject({ message: 'inner' });
});
it.each(['P2010', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ERR_MODULE_NOT_FOUND'])('keeps the code %s on a withheld error', (code) => {
  const err = new Prisma.PrismaClientKnownRequestError('m', { code, clientVersion: '6.19.3' });
  expect(serializeErr(err).code).toBe(code);
});
it.each(['enetunreach', 'E', `E${'A'.repeat(64)}`, '23514'])('drops the code %s on a withheld error', (code) => {
  const err = new Prisma.PrismaClientKnownRequestError('m', { code, clientVersion: '6.19.3' });
  expect(serializeErr(err)).not.toHaveProperty('code');
});
it('keeps meta.timeTaken as a number', () => {
  const err = new Prisma.PrismaClientKnownRequestError('m', { code: 'P2028', clientVersion: '6.19.3', meta: { timeout: 100, timeTaken: 512 } });
  expect(serializeErr(err).meta).toMatchObject({ timeout: 100, timeTaken: 512 });
});
```
If `typeOf` reports `type` differently for the helper's error, assert the measured value. The name and the withheld message are what matter.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/api-errors.test.ts src/lib/log-serializers.test.ts`
Expected: FAIL. `P2034` gives `deadlock` where `serialization` is expected. The pool timeout gives `null`. The `DriverAdapterError` message appears verbatim, and its cause is walked. `ENETUNREACH` and `ERR_MODULE_NOT_FOUND` are dropped. `timeTaken` is dropped.

- [ ] **Step 3: Implement**

In `api-errors.ts`:
```ts
const TRANSIENT_PRISMA_CODE_KIND: ReadonlyMap<string, TransientKind> = new Map([
  ['P2024', 'pool_exhausted'],
  ['P2028', 'tx_budget'],
  ['P2034', 'serialization'],
]);
```
In `transientKindShallow`, before the final `return null`, add `if (isPgPoolTimeout(error)) return 'pool_exhausted';`. Then rewrite the docblocks:
- `TransientKind`: `serialization` lists `40001` and `P2034`, and `pool_exhausted` names pg-pool's wait timeout, linking "Database errors".
- `TRANSIENT_KIND_LEVEL`: delete the argument "Prisma documents `P2034` as write conflict or deadlock ... a write conflict needs RR or serializable, which this repo has none of" (D5: a census of other files, falsified by measurement). Keep the level rationale for `serialization`.

In `log-serializers.ts`:
- `prismaClass` becomes `withheldClass(err)`: the existing `PrismaClient*Error` checks, then `field(err, 'name') === 'DriverAdapterError' ? 'DriverAdapterError' : null`.
- `withheld()`'s message for that class is `` `Driver adapter error ${WITHHELD}` ``.
- The name filter keeps `PRISMA_ERROR_NAME.test(name) || name === 'DriverAdapterError'`.
- In `serialize`, when `withheldPath && !(cause instanceof Error)`, skip the cause entirely: no `cause`, no `causeTruncated`. The `errors` members are unchanged.
- Add `const WITHHELD_CODE = /^(?:P\d{4}|E[A-Z0-9_]{1,63})$/;` and use it on the withheld path in place of `PRISMA_CODE`.
- `META_KEYS`: add `timeTaken: 'number'`, and add `readonly timeTaken?: number` to `SerializedPrismaMeta`.
- The module docblock names the withheld classes.

- [ ] **Step 4: Run green, then the full split suite**

Run: `pnpm exec vitest run --project unit src/lib/api-errors.test.ts src/lib/log-serializers.test.ts`, then the two split invocations from "The window gate" without the JSON diff. With `pnpm run worktree:up` running, both must be fully green: this task is pre-switch.

- [ ] **Step 5: Guard bites**

| Break | Expected failure |
|---|---|
| `P2034 → 'deadlock'` | the `P2034` cases fail on `kind` and `level` |
| remove the `isPgPoolTimeout` arm | `classifies pg-pool's wait timeout ...` fails (`null`) |
| remove the `DriverAdapterError` arm from `withheldClass` | `withholds a DriverAdapterError ...` fails (the raw message appears) |
| walk a non-Error cause under a withheld error again | the same test fails: `cause` present, and the row id appears |
| `WITHHELD_CODE` back to `/^P\d{4}$/` | the `ENETUNREACH` case fails |
| `WITHHELD_CODE` = `/^(?:P\d{4}|E[A-Z]+)$/` | the `ERR_MODULE_NOT_FOUND` case fails |

Restore each break and re-run green. Record the failure texts.

- [ ] **Step 6: Commit**

```bash
pnpm run typecheck && pnpm run lint
git add src/lib/api-errors.ts src/lib/api-errors.test.ts src/lib/log-serializers.ts src/lib/log-serializers.test.ts docs/lock-order.md
git commit -m "fix: P2034 is serialization, pool timeouts are transient, adapter errors are withheld (#885)"
```

---

### Task 4: The switch — client engine through the adapter (opens the red window)

**Files:**
- Modify: `prisma/schema.prisma` (generator: `engineType = "client"`)
- Modify: `src/lib/prisma-client.ts`: wire `PrismaPg`, pass `log` through, no `datasources`, and rewrite the module docblock
- Modify: `src/lib/prisma-client.test.ts` (factory behaviour, engine pins, exit test)
- Modify (the URL-pool callers in D4's table): `tests/stack-ceiling.ts` (`lowStackClient`), `scripts/measure-push-fanout.ts` (both clients), `src/lib/auth/handoff.test.ts:1128`, `src/services/template-room-race.test.ts:52`, `src/services/transition-class-lock-order.test.ts:70`, `src/services/update-class-lock-order.test.ts:79`
- Modify (D8 casts): `src/services/notification-retention.test.ts:68`, `src/services/push-subscription-retention.test.ts:47`, `src/services/waitlist-retention.test.ts:228`, plus every further `UnsupportedNativeDataType` site the run surfaces
- Modify (D4 comments): `src/services/gdpr.ts` (the block near `:1001-1019`), `src/app/api/cron/daily-cleanup/route.ts` ("one connection pool of three (one vCPU)")
- Modify (docs): in `docs/technical-architecture.md`, "Where Prisma comes from" and the push fan-out paragraph near `:1627`
- Write (uncommitted): `$S/red-ledger.tsv` (`file<TAB>full test name<TAB>category`) and `$S/red-ledger.md` (the same rows with their failure line and reason)

**Interfaces:**
- Consumes: Task 2's `poolConfigFor` and `PrismaClientFactoryOptions`.
- Produces: `createPrismaClient(options)` builds `new PrismaClient({ adapter: new PrismaPg(poolConfigFor(options)), errorFormat, log })`. `lowStackClient()` keeps its signature, `Promise<PrismaClient>`.

- [ ] **Step 1: Re-derive the counts this task acts on**

```bash
git grep -lE "connection_limit" -- src tests scripts ':!src/generated'        # 9 files: 6 callers + log-serializers.ts, its test, gdpr.ts
git grep -n "current_database()" -- src tests scripts
for f in $(git grep -l "createPrismaClient(" -- src tests scripts prisma ':!src/lib/prisma-client.ts'); do grep -q '\$disconnect' $f || echo $f; done
```
Record the outputs. If the `connection_limit` callers are not exactly the six in the Files list, stop and add the missing ones to this task.

- [ ] **Step 2: Write the failing factory tests** (`src/lib/prisma-client.test.ts`)

Replace `connects to the url it is given` and add:

```ts
import { spawn } from 'node:child_process';

it('reports a refused port as the adapter\'s DatabaseNotReachable', async () => {
  const client = createPrismaClient({ url: UNREACHABLE });
  try {
    const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const meta = (err as Prisma.PrismaClientKnownRequestError).meta as { driverAdapterError?: { cause?: { kind?: unknown } } };
    expect(meta.driverAdapterError?.cause?.kind).toBe('DatabaseNotReachable');
  } finally {
    await client.$disconnect();
  }
});

it('poolMax reaches pg: one connection serialises two sleeps on one backend', async () => {
  const client = createPrismaClient({ poolMax: 1 });
  try {
    const t0 = Date.now();
    const rows = await Promise.all([
      client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text`,
      client.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid, pg_sleep(0.3)::text`,
    ]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600);
    expect(new Set(rows.map((r) => r[0]?.pid)).size).toBe(1);
  } finally {
    await client.$disconnect();
  }
});

it('connectionTimeoutMs bounds a connect to a silent host', async () => {
  const client = createPrismaClient({ url: 'postgresql://u:p@203.0.113.1:5432/none', connectionTimeoutMs: 500 });
  try {
    const t0 = Date.now();
    const err: unknown = await client.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Connection terminated due to connection timeout');
  } finally {
    await client.$disconnect();
  }
});

// Review Focus 3: a process that skips $disconnect() still exits promptly.
it('a client left connected does not hold a finished process open', async () => {
  const script = "const { createPrismaClient } = require('./src/lib/prisma-client'); const c = createPrismaClient(); c.$queryRaw`SELECT 1`.then(() => console.log('done'));";
  const t0 = Date.now();
  const outcome = await new Promise<number | null | 'killed'>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('killed'); }, 10_000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  expect(outcome).toBe(0);
  expect(Date.now() - t0).toBeLessThan(5000);
}, 15_000);
```

`--import tsx` is the expected way to run TypeScript from `node -e`. If `tsx` resolves the `@/` aliases or the generated client differently under `-e`, write the script to a file under `os.tmpdir()` and run `pnpm exec tsx <file>` instead. Keep the 10 s kill and the 5 s bound.

Re-measure the `errorFormat` test on C+A, because a refused-port model call is now `P1001`. If `minimal` still drops the `→` excerpt and `standard` keeps it, leave the test as it is. Otherwise, produce the model error against the real database instead and keep the same three assertions: `client.teacher.update({ where: { id: crypto.randomUUID() }, data: {} })` gives `P2025`, which carries the invocation excerpt.

Add the engine pins to the funnel `describe`:
```ts
it('declares engineType = "client" in the schema', () => {
  const schema = readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  expect(schema).toMatch(/engineType\s*=\s*"client"/);
});
it('generates no native engine library', () => {
  const dir = path.join(__dirname, '..', 'generated', 'prisma');
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]));
  const files = walk(dir);
  expect(files.length).toBeGreaterThan(0);
  expect(files.filter((f) => f.endsWith('.node'))).toEqual([]);
});
```

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts`
Expected: FAIL.
- The schema pin fails: there is no `engineType`.
- The `.node` pin fails: `libquery_engine-*.node` is present.
- The `DatabaseNotReachable` case fails: the library engine has no `driverAdapterError`.
- The `poolMax` case fails at construction. `createPrismaClient` still spreads `poolMax` into `new PrismaClient(...)`, and Prisma's constructor validation refuses the unknown property. Record that exact message.

- [ ] **Step 4: Flip the engine and wire the adapter**

`prisma/schema.prisma` generator block:
```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
  runtime      = "nodejs"
  engineType   = "client"
}
```
Run `pnpm exec prisma generate`.

`src/lib/prisma-client.ts`:
```ts
import { availableParallelism } from 'node:os';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
// ... Task 2's constants, interfaces and poolConfigFor unchanged ...

export function createPrismaClient(options: PrismaClientFactoryOptions = {}): PrismaClient {
  const adapter = new PrismaPg(poolConfigFor(options));
  return new PrismaClient({
    adapter,
    ...(options.errorFormat === undefined ? {} : { errorFormat: options.errorFormat }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}
```
Rewrite the module docblock's "Prisma reads `DATABASE_URL`" to what is true: the factory reads it, through `poolConfigFor`. If `PgPoolConfig`'s `readonly` fields do not fit `PrismaPg`'s parameter type, spread into a fresh object: `new PrismaPg({ ...poolConfigFor(options) })`. Do not widen the exported interface.

- [ ] **Step 5: Move the URL-pool callers** (D4's table)

- `tests/stack-ceiling.ts` `lowStackClient`:
  ```ts
  export async function lowStackClient(): Promise<PrismaClient> {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('lowStackClient: DATABASE_URL is not set');
    const url = new URL(base);
    url.searchParams.set('options', `-c max_stack_depth=${CEILING_STACK}`);
    const client = createPrismaClient({ url: url.toString() });
    const [row] = await client.$queryRawUnsafe<{ max_stack_depth: string }[]>('SHOW max_stack_depth');
    if (row?.max_stack_depth !== CEILING_STACK) {
      await client.$disconnect();
      throw new Error(`lowStackClient: max_stack_depth reads ${String(row?.max_stack_depth)}, expected ${CEILING_STACK}`);
    }
    return client;
  }
  ```
  Its docblock: Postgres applies the startup option to every connection the pool opens, and the read-back refuses a client the option did not reach. `max_stack_depth` needs the same superuser privilege the session `SET` needed.
- `scripts/measure-push-fanout.ts`: delete `url()`'s `connection_limit` line. The setup client becomes `createPrismaClient({ poolMax: 5 })`, and the per-run client `createPrismaClient({ poolMax: poolSize })`. Remove `url()` if nothing else uses it.
- `src/lib/auth/handoff.test.ts:1128`: `createPrismaClient({ poolMax: nonces.length + 5 })`. Remove the URL construction.
- `template-room-race.test.ts:52`, `transition-class-lock-order.test.ts:70` and `update-class-lock-order.test.ts:79`: `createPrismaClient({ poolMax: 1 })`. Remove the URL construction. Their comments name `poolMax: 1` and keep the reason (one backend, identified once by `pg_backend_pid()`).

- [ ] **Step 6: The three D8 casts**

In each of the three retention tests:
```ts
await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()::text AS current_database`;
```

- [ ] **Step 7: Run the factory tests green**

Run: `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts`
Expected: PASS. Record how long `connectionTimeoutMs bounds a connect ...` and the exit test take in `$S/measurements.md`.

- [ ] **Step 8: Guard bites for this task**

| Break | Expected failure |
|---|---|
| drop `max` from `poolConfigFor`'s return (pg then uses its own default) | `poolMax reaches pg ...` fails at ~300 ms with two PIDs |
| `lowStackClient`: drop the `options` search param | the read-back throws `lowStackClient: max_stack_depth reads 2MB, expected 200kB` (run `pnpm exec vitest run --project unit-sweeps src/services/sweep-page-ceiling.test.ts -t "keeps the lowered stack"`) |
| `allowExitOnIdle: false` | the exit test fails with `expected 'killed' to be 0` (the child lingers for the idle timeout and the test kills it at 10 s) |

Restore each break and re-run green. Record the failure texts.

- [ ] **Step 9: Restart the worktree app, run the full suite and e2e, write the red ledger** (§6 item 1)

Run "The window gate"'s commands with `N=4`, except that no ledger exists yet: everything in `$S/red-4.tsv` is the raw input. Then run e2e:
```bash
pnpm exec playwright test 2>&1 | tee $S/run-t4-e2e.log
```

Write the ledger. Each red vitest test becomes one row in `$S/red-ledger.tsv`, in the form `file<TAB>full name<TAB>category`, and each e2e failure one row with file `e2e:<spec>`. `$S/red-ledger.md` holds the same rows with each failure's first line and the reason for its category. The category rules (an `it` that needs two is split first, and the tie-break picks the latest task):
- **K** (Task 5): `sweep-page-ceiling.test.ts`, or anything calling `isStackDepthError`.
- **C** (Task 6): a 23514 / 23P01 / 23503 / terminal-trigger refusal (409 → 500, `CLASS_FROZEN`, slot exclusions, room-in-use, mint refusal), or an assertion of `PrismaClientUnknownRequestError` or framing on such an error.
- **U** (Task 7): anything through `isUniqueConflictOn`, the P2002 fallback's `detail`, or the `rawTarget` logs.
- **T** (Task 8): a 503, `transientDbFailure`, `55P03`, `40P01`, `40001`, `P2024` or `P2028` expectation.
- **S** (Task 9): any assertion on a serialized `err`: `sqlState`, `constraint`, `trigger`, `rowIds`, `connectorKind`, `txError`, the withheld message, or a parsed log line's `err` facets.

An uncategorised row is this task's to fix before committing: a `::text` cast (list it in the ledger), a `SELECT 1` in place of a timing-relevant `$connect()` (risk 6), or a rewrite to the C+A shape with a verdict in the ledger. Uncategorised e2e failures are expected to be this task's too. If one cannot be fixed that way, stop and report it.

Also record that no vitest project failed with `createPrismaClient: no url given ...` (§6 item 9). If one did, give that runtime the variable. Do not make the factory lazy.

Then re-run the gate's two `comm` lines against the finished ledger, with `N=4`: they must print nothing.

- [ ] **Step 10: `next build` smoke on C+A** (§6 items 2 and 9; Task 10 does the full build measurements)

Run: `pnpm run build 2>&1 | tee $S/build-t4.log; grep -nE "pg-native|query_compiler" $S/build-t4.log || echo "(no pg-native / query_compiler warning)"`
Expected: the build succeeds. A warning goes in `$S/measurements.md` with a verdict. A build failure is this task's to fix; it is not a ledger row.

- [ ] **Step 11: The D4 comments and docs**

- `src/services/gdpr.ts` (`:1001-1019`): keep the reasoning. One erasure can hold a connection for its whole 20 s budget. A request that cannot get a connection fails at the pool's bound and is answered as transient. Delete the "three connections" arithmetic, and link `docs/technical-architecture.md` ("Where Prisma comes from") for the pool size and the bound.
- `src/app/api/cron/daily-cleanup/route.ts`: "one connection pool of three (one vCPU)" becomes "one connection pool".
- `docs/technical-architecture.md`, "Where Prisma comes from":
  - the client engine plus the adapter, and the factory options;
  - the defaults, with the `availableParallelism() * 2 + 1` formula and why it stands in for Prisma's physical-cores formula;
  - the production value: **9, derived from the production host's published spec** (Hetzner CAX21: 4 Ampere Arm vCPUs, which have no SMT, so 4 × 2 + 1). Say it is not measured on the host, and give the re-derivation command: `docker compose -f docker-compose.prod.yml exec app node -e "console.log(require('os').availableParallelism())"`;
  - `$connect()` connects nothing;
  - the `datasources` refusal;
  - `idleTimeoutMillis` of 300 s, and why `allowExitOnIdle`.

  Correct the push fan-out paragraph (`:1627`) to the `poolMax` option.

- [ ] **Step 12: Commit** (red by design)

```bash
pnpm run typecheck && pnpm run lint
git add prisma/schema.prisma src/lib/prisma-client.ts src/lib/prisma-client.test.ts tests/stack-ceiling.ts \
  scripts/measure-push-fanout.ts src/lib/auth/handoff.test.ts src/services/template-room-race.test.ts \
  src/services/transition-class-lock-order.test.ts src/services/update-class-lock-order.test.ts \
  src/services/notification-retention.test.ts src/services/push-subscription-retention.test.ts \
  src/services/waitlist-retention.test.ts src/services/gdpr.ts src/app/api/cron/daily-cleanup/route.ts \
  docs/technical-architecture.md
# plus every further file Step 9 fixed, by exact path
git commit -m "feat: run Prisma on the client engine through the pg driver adapter (#885)

Suite red by design (red window, plan Tasks 4-9): <the categories with ledger rows>."
```
`src/generated/` is not tracked. Confirm with `git status --short src/generated`, which should print nothing.

---

### Task 5: Ceiling tests re-based on the bind-parameter limit (D11) — turns K green

**Files:**
- Modify: `tests/stack-ceiling.ts` (`isStackDepthError`, parameter recording, the `CEILING_ROWS` and module docblocks)
- Modify: `src/services/sweep-page-ceiling.test.ts`
- Modify: `src/lib/read-in-pages.ts` (the `SWEEP_PAGE_SIZE` docblock only)
- Modify: `docs/technical-architecture.md`, "Relation loads over platform-wide sets" (`:300-312`) and the `lowStackClient` paragraph (`:325-326`)

**Interfaces:**
- Consumes: `pgErrorOf`, Task 4's `lowStackClient()`, and the `log` option.
- Produces (in `tests/stack-ceiling.ts`):
  ```ts
  export function isStackDepthError(err: unknown): boolean;          // pgErrorOf(err)?.sqlState === '54001'
  export function peakBoundParams(client: PrismaClient): number;     // max params of any statement since the last reset
  export function resetBoundParams(client: PrismaClient): void;
  export const BIND_LIMIT_PARENTS = 21_844;                          // largest composite load that binds ≤ 65,535 params
  ```

- [ ] **Step 1: Add the recorder and measure every site's peak first**

In `tests/stack-ceiling.ts`, add:
```ts
import { pgErrorOf } from '@/lib/pg-error';

type QueryEvents = { $on(event: 'query', cb: (e: Prisma.QueryEvent) => void): void };
const peaks = new WeakMap<PrismaClient, { peak: number }>();

/** Parameters bound by one statement, from Prisma's query event. */
function paramCount(event: Prisma.QueryEvent): number {
  const params: unknown = JSON.parse(event.params);
  return Array.isArray(params) ? params.length : 0;
}

export function peakBoundParams(client: PrismaClient): number {
  const entry = peaks.get(client);
  if (!entry) throw new Error('peakBoundParams: not a lowStackClient');
  return entry.peak;
}
export function resetBoundParams(client: PrismaClient): void {
  const entry = peaks.get(client);
  if (!entry) throw new Error('resetBoundParams: not a lowStackClient');
  entry.peak = 0;
}
```
In `lowStackClient`, build the client with `log: [{ emit: 'event', level: 'query' }]`, then:
```ts
const entry = { peak: 0 };
peaks.set(client, entry);
(client as unknown as QueryEvents).$on('query', (e) => { entry.peak = Math.max(entry.peak, paramCount(e)); });
```

Add a temporary `console.log('PEAK', <describe name>, peakBoundParams(low))` after each per-site read, and run the file twice:
1. as is: the page-sized peak;
2. with `src/lib/read-in-pages.ts` temporarily calling `fetchPage(after, 1_000_000)` and checking `page.length` against `1_000_000`: the unpaged peak.

Record both per site in `$S/measurements.md`, then remove the log lines and restore `read-in-pages.ts`. For each site, the pre-decided rule applies:
- page-sized peak = `3 * SWEEP_PAGE_SIZE + 1` and unpaged peak = `3 * CEILING_ROWS + 1`: the site asserts the spec's bound;
- otherwise: the site asserts `k * SWEEP_PAGE_SIZE + c`, with its measured `k` and `c`, provided its unpaged peak is above that bound. If even the unpaged peak is not above any page-sized bound, stop and report: that site's test cannot fail on the number.

- [ ] **Step 2: Write the failing tests**

In `src/services/sweep-page-ceiling.test.ts`:
1. Keep `splits SWEEP_PAGE_SIZE from CEILING_ROWS row-value tuples`. `rowValueIn(CEILING_ROWS)` is now `P2010` with `originalCode: '54001'`.
2. Replace `rejects an unpaged CEILING_ROWS relation load ...` with:
   ```ts
   const PAGE_PARAM_BOUND = 3 * SWEEP_PAGE_SIZE + 1;

   it('a paged relation load binds a page\'s parameters; an unpaged one binds the whole set\'s', async () => {
     const load = (ids: string[]) => low.class.findMany({ where: { id: { in: ids } }, include: { calendarEntry: true } });
     resetBoundParams(low);
     await expect(load(classIds.slice(0, SWEEP_PAGE_SIZE))).resolves.toHaveLength(SWEEP_PAGE_SIZE);
     expect(peakBoundParams(low)).toBe(PAGE_PARAM_BOUND);
     resetBoundParams(low);
     await expect(load(classIds)).resolves.toHaveLength(CEILING_ROWS);
     expect(peakBoundParams(low)).toBe(3 * CEILING_ROWS + 1);
   });
   ```
3. In every per-site `describe`, call `resetBoundParams(low)` before the read. After the read, and before `expectLowered`, add:
   ```ts
   expect(peakBoundParams(low)).toBeGreaterThan(0);
   expect(peakBoundParams(low)).toBeLessThanOrEqual(PAGE_PARAM_BOUND);   // or the site's own bound from Step 1
   ```
   Rename each `it` from "... under the lowered stack" to "... binding at most a page's parameters per statement".
4. Add a new `describe('bind-parameter limit')` in the same serial file:
   ```ts
   describe('bind-parameter limit', () => {
     it('an unpaged composite load over BIND_LIMIT_PARENTS + 1 parents fails 08P01; BIND_LIMIT_PARENTS resolves', async () => {
       const ids = await seedClassesBySql(prisma, BIND_LIMIT_PARENTS + 1);
       const load = (n: number) => prisma.class.findMany({ where: { id: { in: ids.slice(0, n) } }, include: { calendarEntry: true } });
       await expect(load(BIND_LIMIT_PARENTS)).resolves.toHaveLength(BIND_LIMIT_PARENTS);
       const err: unknown = await load(BIND_LIMIT_PARENTS + 1).then(() => 'resolved', (e: unknown) => e);
       expect(pgErrorOf(err)?.sqlState).toBe('08P01');
     }, 120_000);
   });
   ```
   `seedClassesBySql` is a local helper in this file that ports the seeding block of `$S/rev2/ceiling.ts` onto `createPrismaClient`. It creates one teacher, room and `TeacherRoom` through Prisma, then runs one `INSERT ... SELECT generate_series` CTE into `CalendarEntry` and `Class`. Cleanup goes in `afterAll`: `DELETE FROM "CalendarEntry" WHERE "teacherId" = $1`, then the room, the teacher and the account.

- [ ] **Step 3: Run and watch them fail**

Run: `pnpm exec vitest run --project unit-sweeps src/services/sweep-page-ceiling.test.ts`
Expected: FAIL. The `rowValueIn` case fails on `isStackDepthError`, because the old matcher reads `meta.code` (ledger K). The new tests fail on `BIND_LIMIT_PARENTS` being undefined.

- [ ] **Step 4: Implement**

- `isStackDepthError`: `return pgErrorOf(err)?.sqlState === '54001';`. Its docblock says its producer is app-authored row-value SQL; a Prisma relation load no longer reaches it.
- Export `BIND_LIMIT_PARENTS = 21_844` with a one-line docblock: 3n + 1 parameters, against a wire-protocol maximum of 65,535.
- Rewrite the module docblock and `CEILING_ROWS`'s docblock to say what each piece proves now:
  - `CEILING_STACK` and `lowStackClient`: app-authored row-value SQL still overflows the parser's stack.
  - `CEILING_ROWS`: a parent set larger than a page, so un-paging a site moves its peak past the page bound.

- [ ] **Step 5: Run green and record the bind-limit cost** (§6 item 12)

Run: `/usr/bin/time -p pnpm exec vitest run --project unit-sweeps src/services/sweep-page-ceiling.test.ts -t "bind-parameter limit"`
Record the seed time and the test time in `$S/measurements.md`. **Decision rule:** if the describe, seed plus test, takes more than **20 s** on the dev machine, delete it. Put the measured numbers in `docs/technical-architecture.md`'s "Relation loads" section instead. Add a standalone re-derivation script as a code block there: the `seedClassesBySql` port plus the two loads, run with `pnpm exec tsx <file> 21844 21845`. It must run as written from the repo root, with no scratch-generated client and no hard-coded worktree path. Name the 20 s threshold as a plan choice in the PR body.

- [ ] **Step 6: Guard bites**

| Break | Expected failure |
|---|---|
| `isStackDepthError` compares against `'54000'` | `splits SWEEP_PAGE_SIZE from CEILING_ROWS ...` fails (`expected false to be true`) |
| un-page every site at once (Step 1's `read-in-pages.ts` mutation) | **every** per-site test fails on its `toBeLessThanOrEqual`; the received peaks match Step 1's unpaged column |
| bind-limit: load only `BIND_LIMIT_PARENTS` parents as the failing case | the `08P01` assertion fails (the load resolves). If Step 5 moved the test to the docs, run the documented script with `21844 21844` instead: it must report no `08P01` |

Restore each break and re-run green.

- [ ] **Step 7: Docs**

- `src/lib/read-in-pages.ts:1-7`, the `SWEEP_PAGE_SIZE` docblock: give the bind-parameter reason (a composite relation load binds one parameter per key column per parent, and a statement carries a bounded number). Keep the link to "Relation loads over platform-wide sets" and state no threshold.
- `docs/technical-architecture.md`, "Relation loads over platform-wide sets":
  - the mechanism is now three scalar `IN` lists; quote §2 item 14's SQL;
  - Prisma loads no longer overflow the stack;
  - the bind limit is 21,844 composite parents, failing with `08P01`, and the query compiler does not split a composite relation load;
  - an `in:` list is split only in a plain `findMany` (no `orderBy`, no `take`) or a single-key relation load, into statements of at most 32,765 values; every other statement over 32,766 bound parameters is refused before it is sent, with `P2029` (measured in Task 5 for the plain `findMany`, in Task 11 for the rest);
  - the rule is unchanged;
  - "How the ceiling tests reproduce it" becomes the parameter-count mechanism, the startup-option `lowStackClient`, and the one stack test for app SQL;
  - every number carries its re-derivation.

- [ ] **Step 8: Window gate, then commit**

Run "The window gate" with `N=5` and category `K`. Then commit:
```bash
git add tests/stack-ceiling.ts src/services/sweep-page-ceiling.test.ts src/lib/read-in-pages.ts docs/technical-architecture.md
git commit -m "test: ceiling tests assert bound parameters, the stack test keeps app SQL (#885)

Suite red by design (red window, plan Tasks 4-9): C U T S."
```

---

### Task 6: Conflict matchers on `pgErrorOf` — turns C green

**Files:**
- Modify: `src/lib/api-errors.ts`:
  - `isTerminalStatusViolation` becomes `terminalViolationOf`;
  - the trigger facet in `classifyApiError`;
  - `isRestrictViolationOn`;
  - every docblock in these that quotes the library-engine shapes now links "Database errors".

  The P2002 fallback is **not** touched here; that is Task 7.
- Modify: `src/lib/check-violation.ts`, `src/lib/exclusion-conflict.ts`, `src/services/payout-notice.ts` (`isMintKeyRefusal` and the `PAUSE_TOKEN_FOREIGN_KEYS` docblock)
- Modify (docblocks naming `meta.constraint`): `src/services/rule-lifecycle.ts:143`, `src/app/api/rooms/[id]/route.ts:82`, `src/services/payout-notice.ts:7`
- Modify: `src/lib/pg-error.test.ts` (the real-DB conflict matrix and the fidelity tests)
- **Tests fabricating the old shapes for these matchers** (from the census; this task owns them): `src/lib/api-errors.test.ts` (the 23514 / terminal-trigger, P2003 and 23P01 cases), `src/lib/check-violation.test.ts`, `src/lib/exclusion-conflict.test.ts`, `src/app/api/class-templates/[id]/vanished-room-double-race.test.ts`, `src/app/api/class-templates/route.test.ts`, `src/services/payout-notice.test.ts`
- **Produced-error tests** (from the census; the ledger's C rows are authoritative): `src/lib/entry-rule-kind-guard.test.ts`, `src/services/calendar-entry.test.ts`, `src/services/class-terminal-date.test.ts`, `src/services/class-terminal-status.test.ts`, `src/services/rule-lifecycle.test.ts`, `src/services/schedule-rule-constraints.test.ts` (the 23514 / 23P01 lines), `tests/integration/currency-frozen-guards.test.ts`, `src/services/payout-notice-delivery.test.ts`, `src/services/room-deletion.test.ts`, `src/services/generation-transaction.test.ts`

**Interfaces:**
- Consumes: `pgErrorOf`, `PgError`, `driverAdapterError`, `knownWithAdapterCause`, `pgCause`.
- Produces: `terminalViolationOf(error: unknown): PgError | null` (private to `api-errors.ts`). The exported signatures are unchanged: `isCheckViolationOn(err, constraint)`, `isExclusionConflictOn(err, constraint)`, `isRestrictViolationOn(error, constraints)`.

- [ ] **Step 1: Write the failing real-DB matrix** in `src/lib/pg-error.test.ts` (`describe('produced against the real database: conflict codes')`)

Use `createPrismaClient()`, `createClassFixture` from `tests/class-fixtures.ts`, and `tests/room-fixtures.ts`. Each case gets two `it`s:
- **classification** (C):
  ```ts
  function expectConflict(err: unknown, want: { sqlState: string; constraint?: string; status: 409 | 500; code?: string }): void {
    const pg = pgErrorOf(err);
    expect(pg?.sqlState).toBe(want.sqlState);
    expect(pg?.constraint).toBe(want.constraint);
    const failure = classifyApiError(err);
    expect(failure.status).toBe(want.status);
    if (want.code) expect(failure).toMatchObject({ code: want.code });
  }
  ```
- **log facets** (S, red until Task 9): `serializeErr(err)` carries the `sqlState`, the `constraint` (or the `trigger`), and the withheld message. Neither the primary message nor `Failing row contains` appears anywhere in the JSON output. These `it`s are S rows in the ledger.

Cases, typed and raw where both are reachable, with the exact expected classification:

| Case | `sqlState` / `constraint` | `classifyApiError` | Matcher verdict |
|---|---|---|---|
| CHECK `Class_live_needs_open_room` via the `teacherRoom.update` cascade (typed), and the same write by `$executeRaw` (raw) | `23514` / `Class_live_needs_open_room` | 500, no code (no branch maps a CHECK) | `isCheckViolationOn(err, 'Class_live_needs_open_room')` true |
| trigger: `class.update` status on a completed class (typed); `calendarEntry.update` of `date` on a frozen entry (typed); one raw | `23514` / undefined | 409 `CLASS_FROZEN`, `detail.trigger` `'status'` / `'date'` / per the raw row's tail | `isCheckViolationOn(err, 'Class_live_needs_open_room')` false |
| `CalendarEntry_teacher_slot_excl`, typed and raw | `23P01` / the name | 409 `ENTRY_SLOT_TAKEN` | `isExclusionConflictOn(err, name)` true, and false for the other name |
| `ScheduleRule_teacher_slot_excl`, typed and raw | `23P01` / the name | 409 `RULE_SLOT_TAKEN` | as above |
| restrict: `teacherRoom.delete` blocked by `Class_teacherRoomId_roomArchived_fkey` (typed); the same delete raw | `23503` / that name | 500 (no generic branch) | `isRestrictViolationOn(err, ['Class_teacherRoomId_roomArchived_fkey'])` true for both (risk 4a) |
| dangling insert: `teacherRoom.create` with a random `roomId` | `23503` / `TeacherRoom_roomId_fkey` | 500 | `isRestrictViolationOn(err, ['TeacherRoom_roomId_fkey'])` true |

The dangling-insert name is pinned to the spec's expected `'TeacherRoom_roomId_fkey'` (spec:276). If the measurement differs, for example the adapter wrote `{fields}` and there is no name, stop and report it. Do not adjust the assertion to the measurement.

**Fidelity** (§7), one `it` per path:
```ts
it('the helper fabricates a typed DriverAdapterError identical to a produced one', async () => {
  const real = await produceTypedTriggerRaise();              // class.update status on a completed class
  const fake = driverAdapterError(pgCause('23514', pgErrorOf(real)!.message));
  expect(pgErrorOf(fake)).toEqual(pgErrorOf(real));
  expect(Object.keys(fake).sort()).toEqual(Object.keys(real as object).sort());
  expect(Object.keys((fake as { cause: object }).cause).sort())
    .toEqual(Object.keys((real as { cause: object }).cause).sort());
});
// and: Known P2010 (raw 23514) vs knownWithAdapterCause('P2010', pgCause('23514', msg)),
//      Known P2003 (the restrict delete) vs knownWithAdapterCause('P2003', pgCause('23503', msg, { constraint: { index } }), { modelName: 'TeacherRoom' }),
//      comparing Object.keys(meta), the driverAdapterError's keys, and its cause's keys.
```
If the own-key sets differ, fix `tests/adapter-errors.ts` to match the real shape, including whether keys that hold `undefined` are present at all.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts`
Expected: FAIL. The typed trigger cases classify as 500 instead of 409 `CLASS_FROZEN`. The exclusion cases classify as 500 instead of `*_SLOT_TAKEN`. Every matcher verdict is `false`.

- [ ] **Step 3: Implement the matchers**

`src/lib/check-violation.ts`:
```ts
import { pgErrorOf } from '@/lib/pg-error';

export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  if (constraint === '') return false;
  const pg = pgErrorOf(err);
  return pg !== null && pg.sqlState === '23514' && pg.constraint === constraint;
}
```
Docblock: keep "both the SQLSTATE and the name are required, and why" (the terminality triggers also raise `23514`). Replace the two-shapes enumeration with one line linking "Database errors". Keep the empty-name comment.

`src/lib/exclusion-conflict.ts`:
```ts
import { pgErrorOf } from '@/lib/pg-error';

export function isExclusionConflictOn(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg !== null && pg.sqlState === '23P01' && pg.constraint === constraint;
}
```
Docblock: say why this is separate from `isUniqueConflictOn`, and that typed and raw are both admitted because both carry the cause. Link "Database errors". Delete the shape enumeration and the claim about `calendar-entry.test.ts`, which reaches past this file. Drop the now-unused `Prisma` import.

`src/lib/api-errors.ts`:
```ts
function terminalViolationOf(error: unknown): PgError | null {
  const pg = pgErrorOf(error);
  return pg !== null && pg.sqlState === '23514' && pg.message.includes('which is terminal') ? pg : null;
}

export function isRestrictViolationOn(error: unknown, constraints: readonly string[]): boolean {
  const pg = pgErrorOf(error);
  return pg !== null && pg.sqlState === '23503' && pg.constraint !== undefined && constraints.includes(pg.constraint);
}
```
In `classifyApiError`: `const terminal = terminalViolationOf(error); if (terminal) { ... TERMINAL_TRIGGER_FACETS.find((facet) => terminal.message.includes(TERMINAL_TRIGGER_TAILS[facet])) ... }`. The docblock's typed/raw quoting paragraphs become one link to "Database errors". Keep the argument for matching on wording rather than on the code.

`src/services/payout-notice.ts`:
```ts
function isMintKeyRefusal(err: unknown): boolean {
  const pg = pgErrorOf(err);
  return pg !== null && pg.sqlState === '23503' && pg.constraint !== undefined && PAUSE_TOKEN_FOREIGN_KEYS.has(pg.constraint);
}
```
`PAUSE_TOKEN_FOREIGN_KEYS` docblock: "The token's own foreign keys, by constraint name." Drop the `Prisma` import if it becomes unused.

In `rule-lifecycle.ts:143`, `rooms/[id]/route.ts:82` and `payout-notice.ts:7`, replace `meta.constraint` with "the constraint name".

- [ ] **Step 4: Rewrite this task's test files**

- **Fabricated** old shapes, for example `new PrismaClientUnknownRequestError('...PostgresError { code: "23514" ...')`, `meta: { constraint }` or ``Code: `23P01` ``: fabricate through `driverAdapterError` / `knownWithAdapterCause` / `pgCause` instead. This covers the six files listed under "Tests fabricating" above. `check-violation.test.ts:16`'s comment on the P2010 framing is rewritten too (§8's table row).
- **Produced** errors asserted by shape (`toBeInstanceOf(Prisma.PrismaClientUnknownRequestError)`, `String(err)` against `/23514/`, ``Code: ` ``): assert `pgErrorOf(err)` instead, meaning its `sqlState` plus the `constraint` or the message tail.
- `payout-notice-delivery.test.ts` and `room-deletion.test.ts` read `meta?.constraint` off produced errors. Change them to `pgErrorOf(err)?.constraint`.
- `generation-transaction.test.ts:222`: `expect(pgErrorOf(caught)?.sqlState).not.toBe('25P02')`.

- [ ] **Step 5: Run green**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts src/lib/check-violation.test.ts src/lib/exclusion-conflict.test.ts src/lib/api-errors.test.ts`

- [ ] **Step 6: Guard bites** (on the real-DB matrix; warm the touched routes before scoring any integration row)

| Break | Expected failure |
|---|---|
| `pgErrorOf` reads `cause.code` instead of `originalCode` | every `23503` case fails (that kind has no `code`): `null` / matcher false |
| delete `adapterCauseOf`'s `DriverAdapterError` branch | every typed `23514` and `23P01` case fails (500 or matcher false) |
| delete `adapterCauseOf`'s Known branch | every raw case and every `P2003` case fails |
| `isCheckViolationOn`: drop `pg.constraint === constraint` | the trigger cases' `isCheckViolationOn ... false` fails |
| `terminalViolationOf`: drop `message.includes('which is terminal')` | the CHECK case classifies `CLASS_FROZEN` and fails |
| `isExclusionConflictOn`: compare against `'23514'` | every exclusion case fails |
| `isRestrictViolationOn`: read `(error as Known).meta?.constraint` | the restrict cases fail |
| `isMintKeyRefusal`: read `meta.constraint` | `payout-notice.test.ts`'s mint-refusal case fails |

Restore each break and re-run green. Record the failure texts. Task 8 Step 6 runs the first three bites again against the transient matrix.

- [ ] **Step 7: Window gate, then commit**

Run "The window gate" with `N=6` and category `C`. Then commit:
```bash
git add src/lib/api-errors.ts src/lib/check-violation.ts src/lib/exclusion-conflict.ts src/services/payout-notice.ts \
  src/services/rule-lifecycle.ts 'src/app/api/rooms/[id]/route.ts' src/lib/pg-error.test.ts tests/adapter-errors.ts \
  src/lib/api-errors.test.ts src/lib/check-violation.test.ts src/lib/exclusion-conflict.test.ts \
  'src/app/api/class-templates/[id]/vanished-room-double-race.test.ts' src/app/api/class-templates/route.test.ts \
  src/services/payout-notice.test.ts src/lib/entry-rule-kind-guard.test.ts src/services/calendar-entry.test.ts \
  src/services/class-terminal-date.test.ts src/services/class-terminal-status.test.ts src/services/rule-lifecycle.test.ts \
  src/services/schedule-rule-constraints.test.ts tests/integration/currency-frozen-guards.test.ts \
  src/services/payout-notice-delivery.test.ts src/services/room-deletion.test.ts src/services/generation-transaction.test.ts
# plus any further C-row file from the ledger, by exact path
git commit -m "fix: conflict matchers read the adapter's SQLSTATE and constraint (#885)

Suite red by design (red window, plan Tasks 4-9): U T S."
```

---

### Task 7: `isUniqueConflictOn` takes constraint names (D3) — turns U green

**Files:**
- Modify: `src/lib/unique-conflict.ts`. Add `UNIQUE_CONSTRAINTS` and `UniqueConstraintName`, change to the new signature, delete `extractColumnIdentifier`, and rewrite the docblock.
- Modify: `src/lib/api-errors.ts`. The P2002 fallback's `detail` becomes `{ constraint: pgErrorOf(error)?.constraint }`, and its comment's "`meta.target` names the constraint" becomes "`constraint` names it".
- Modify (the call lines, re-derived in Step 1): `src/app/api/account/student-profile/route.ts`, `src/app/api/account/teacher-profile/route.ts`, `src/app/api/registrations/route.ts`, `src/app/api/rooms/[id]/publish/route.ts`, `src/app/api/rooms/[id]/route.ts`, `src/app/api/rooms/route.ts`, `src/app/api/teacher-rooms/route.ts`, `src/app/api/teachers/[id]/route.ts`, `src/services/class-lifecycle.ts`, `src/services/invitations.ts`
- Modify (`rawTarget` logs become `constraint`): `account/student-profile/route.ts:202`, `account/teacher-profile/route.ts:189`, `teacher-rooms/route.ts:135`, `services/invitations.ts:419`. Also the comment at `registrations/route.ts:542`.
- Create: `tests/holder-race.ts`. Move `latch`, `ownPid`, `waiterOf` and `raceBehindHolder` out of `src/app/api/account/teacher-profile/route-lock-order.test.ts`, generalising `raceBehindHolder`'s `request` to `() => Promise<T>` and its result to `{ result: T; parked: boolean }`. The existing file imports them from there and its tests are unchanged.
- Create: `src/lib/pg-error-sites.test.ts`. Its header carries `@serial-tier lock-contention` with the reason that it holds uncommitted twins and asserts the waiter parked. Append it to `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`.
- **Tests fabricating the old shapes for this matcher, or for the P2002 `detail`** (from the census; this task owns them): `src/lib/unique-conflict.test.ts`, `src/lib/api-utils.test.ts`, `src/app/api/registrations/route.test.ts` (its P2002 `meta` fabrication), `src/lib/api-errors.test.ts` (the P2002 fallback `detail` cases)
- **Produced-error and call-site tests** (from the census; the ledger's U rows are authoritative): `src/services/slot-constraints.test.ts`, `src/services/waitlist-position-index.test.ts`, `src/services/schedule-rule-constraints.test.ts` (the `meta.target` lines), `tests/integration/live-profile-unique.test.ts`, `tests/integration/room-identity-index.test.ts`, `tests/integration/erased-profile-restart.test.ts:167` (a comment), `src/lib/pg-error.test.ts` (the registry and the 23505 cases); and, for a verdict only, `src/services/teacher-profile.test.ts`, `src/services/admin-grant-constraints.test.ts`, `src/lib/push-schema.test.ts`
- Modify (docs): `docs/data-model.md:1105` (room identity is matched by constraint name)

**Interfaces:**
- Produces (exact):
  ```ts
  export const UNIQUE_CONSTRAINTS = [ /* every name a caller passes, src and tests */ ] as const;
  export type UniqueConstraintName = (typeof UNIQUE_CONSTRAINTS)[number];
  export function isUniqueConflictOn(err: unknown, names: readonly UniqueConstraintName[]): boolean;
  // tests/holder-race.ts
  export function raceBehindHolder<T>(hold: (tx: Prisma.TransactionClient) => Promise<void>, request: () => Promise<T>): Promise<{ result: T; parked: boolean }>;
  ```

- [ ] **Step 1: Re-derive the counts**

```bash
git grep -n "isUniqueConflictOn(err" -- src ':!*.test.ts' | wc -l                                   # 18 grep lines, one of them the definition
git grep -o "isUniqueConflictOn(err" -- src ':!*.test.ts' ':!src/lib/unique-conflict.ts' | wc -l     # 18 calls on 17 lines (spec defect 5)
git grep -n "isUniqueConflictOn(" -- '*.test.ts' 'tests/**' | wc -l                                  # 28, one of them a comment
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_dev_issue_885 -Atc \
  "SELECT c.relname, i.indexrelid::regclass FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE i.indisunique AND c.relname IN ('Student','Teacher','Account','Invitation','TeacherRoom') ORDER BY c.relname, i.indexrelid"
```
Record the outputs. The last query is the index-OID order Postgres checks, which Review Focus 1 rests on. Every database built from these migrations has the same order, because migration order fixes it. If the counts differ, reconcile them before going on.

- [ ] **Step 2: Per-site verdicts** (D3; put this table in the task report and the PR body)

| Site | `try` block writes | Collisions it can raise (in the order Postgres reports them) | Names passed |
|---|---|---|---|
| `student-profile` session (`:168`) | `Student` with a scalar `accountId` | `Student_email_key` for a double-tap (same account and email); `Student_account_live_unique` for a same-account twin with a different email | both |
| `student-profile` ticket (`:180`) | `Student` plus a nested `Account` create (the `Account` is inserted first) | `Account_email_key` when the address has an account; `Student_email_key` when a student row holds it without one | both |
| `teacher-profile` `isSessionCollision` (`:79-81`) | `Teacher` with a scalar `accountId` | `Teacher_email_key` (double-tap), `Teacher_pageSlug_key`, `Teacher_account_live_unique` (same account, different email and slug) | all three. `Account_email_key` is **not** listed (spec defect 1) |
| `teacher-profile` `:144`, ticket `:156` | — | `Teacher_pageSlug_key` | `Teacher_pageSlug_key` |
| `teacher-profile` ticket `:168` | `Teacher` plus a nested `Account` | `Account_email_key`, `Teacher_email_key` | both |
| `registrations/route.ts:544` (rethrows) | the booking transaction | `Registration_classId_studentId_key`. The re-read is of `Registration`, so any other key's collision falls to `classifyApiError`'s 409, as the column match did (its re-read found no twin and rethrew) | `Registration_classId_studentId_key` |
| `rooms/[id]/publish:84` (rethrows) | a `Room` update to public | `Room_public_identity_unique` | it |
| `rooms/[id]/route.ts:214` (rethrows) | a `Room` update | `Room_private_identity_unique` | it |
| `rooms/route.ts:99-100` (rethrows) | a `Room` create | both room keys | both |
| `teacher-rooms/route.ts:117` | `TeacherRoom` | `TeacherRoom_teacherId_roomId_key` (`TeacherRoom_id_isArchived_key` cannot collide: the `id` is fresh) | it |
| `teachers/[id]/route.ts:99` | a `Teacher` update | `Teacher_pageSlug_key` | it |
| `class-lifecycle.ts:1792` | `CalendarEntry` | `CalendarEntry_scheduleRuleId_date_key` | it |
| `invitations.ts:402` | `Invitation` | `Invitation_teacherId_email_key` | it |

**By design, not a matcher gap:** a session-path collision on the email alone, where a *different* account holds the address, finds no live side for the caller's own account. The route then throws on purpose (`student-profile/route.ts:176`, `teacher-profile/route.ts:154`: "account key collision with no live ... side"), which is a 500 whatever the matcher answers.

Before applying the table, the implementer **reads each `try` block** and confirms that the "writes" column is complete, including nested writes and anything a called service writes. A missing write gets a verdict row added here, never a silent fix.

- [ ] **Step 3: Write the failing tests**

`src/lib/unique-conflict.test.ts`: replace the column cases with name cases fabricated as `knownWithAdapterCause('P2002', pgCause('23505', 'duplicate key value violates unique constraint "<name>"'))`:
- matches its own name;
- does not match a sibling name on the same columns (`Student_email_key` against `Account_email_key`);
- matches the truncated-fields expression key `Room_private_identity_unique`, fabricated with `constraint: { fields: ['"createdById"', 'lower(TRIM(BOTH FROM address'] }`;
- a raw `P2010` 23505 on a listed name matches (risk 4a);
- `P2025`, a non-23505 Known error, `null` and a plain `Error` do not match.

Add a type-level case, `// @ts-expect-error unknown name` on `isUniqueConflictOn(err, ['Teacher_bogus_key'])`. `pnpm run typecheck` checks it, not vitest.

`src/lib/api-errors.test.ts`: the P2002 fallback's `detail` is `{ constraint: '<name>' }`.

`src/lib/pg-error.test.ts`, parallel tier, no races:
- **registry**:
  ```ts
  it('every UNIQUE_CONSTRAINTS member is a unique index in the database', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname::text AS indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'`;
    const present = new Set(rows.map((r) => r.indexname));
    expect(UNIQUE_CONSTRAINTS.filter((n) => !present.has(n))).toEqual([]);
  });
  ```
- **produced 23505 cases** (§7, all four assertions per case, I-7), each with a classification `it` (U) and a log-facet `it` (S, red until Task 9):

  | Case | `pgErrorOf` | `isUniqueConflictOn` | `classifyApiError` | `serializeErr` (S) |
  |---|---|---|---|---|
  | `Teacher_pageSlug_key` (single), typed | `23505` / name | `[name]` true | 409 `UNIQUE_CONFLICT`, `detail.constraint` = name | `sqlState` `23505`, `constraint` name, message withheld |
  | `TeacherRoom_teacherId_roomId_key` (composite), typed | same | same | same | same |
  | `Room_private_identity_unique` and `Room_public_identity_unique` (expression, partial), typed | same | same | same | same |
  | one raw `INSERT` hitting `Teacher_pageSlug_key` | same | true (risk 4a) | 500: the P2002 fallback is deliberately not widened to raw (spec:333) | same |

`src/lib/pg-error-sites.test.ts`, serial: every local-net collision is produced behind a held, uncommitted twin using `raceBehindHolder`, with `POST` invoked in-process (`seedSession`, `cookie`, `NextRequest`) as `teacher-profile/route-lock-order.test.ts` does. Every case asserts `parked === true`, so a run where the pre-check won and the `catch` never ran fails instead of passing:

| Case | Holder holds (uncommitted) | Reported name | Expected answer |
|---|---|---|---|
| student-profile session, double-tap | a `Student` on the caller's account with the same email | `Student_email_key` | `expectUnchanged` |
| student-profile session, same account, different email | a `Student` on the caller's account with another email | `Student_account_live_unique` | `expectUnchanged` |
| teacher-profile session, same account, different email and slug | a `Teacher` on the caller's account with another email and slug | `Teacher_account_live_unique` | `expectRefusal(res, 'ALREADY_TEACHER')` (its `pageSlug` differs, and `pageSlug` is a compared field) |
| invitations | an `Invitation` for the same `(teacherId, email)` with a different `firstName` | `Invitation_teacherId_email_key` | `inviteContact` resolves `{ ok: false, reason: 'ALREADY_INVITED' }` |
| teacher-rooms | a `TeacherRoom` for the same `(teacherId, roomId)` with the request's own values | `TeacherRoom_teacherId_roomId_key` | `expectUnchanged` |

The teacher-profile double-tap (`Teacher_email_key` → `unchanged`, and `ALREADY_TEACHER` for a different bio) and the slug taken by another account (`SLUG_TAKEN`) are already produced this way by `teacher-profile/route-lock-order.test.ts:133,161,190`, and stay there. The ticket paths need no race, because no pre-check stands in front of the `Account` insert. They live in the same file, so the local-net evidence is in one place:

| Case | Seed (committed) | Reported name | Expected answer |
|---|---|---|---|
| student-profile ticket | an `Account` for the ticket's address | `Account_email_key` | `expectRefusal(res, 'ACCOUNT_EXISTS')` |
| teacher-profile ticket | an `Account` for the ticket's address | `Account_email_key` | `expectRefusal(res, 'ACCOUNT_EXISTS')` |

The existing integration cases (`tests/integration/student-profile-ticket.test.ts:200`, `tests/integration/teacher-signup-api.test.ts:653`) stay as they are.

- [ ] **Step 4: Run and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/unique-conflict.test.ts src/lib/pg-error.test.ts`, then `pnpm exec vitest run --project unit-sweeps src/lib/pg-error-sites.test.ts`, then `pnpm run typecheck`.
Expected:
- vitest fails with `UNIQUE_CONSTRAINTS` undefined (a `TypeError`, since vitest does not typecheck);
- the local-net cases fail with 500;
- typecheck fails on the unknown-name argument (no `@ts-expect-error` target yet) and on the call sites' column arrays.

- [ ] **Step 5: Implement**

```ts
// src/lib/unique-conflict.ts
import { pgErrorOf } from '@/lib/pg-error';

/** Every unique index a caller names; `pg-error.test.ts` holds each to `pg_indexes`. */
export const UNIQUE_CONSTRAINTS = [
  'Account_email_key',
  'CalendarEntry_scheduleRuleId_date_key',
  'Invitation_teacherId_email_key',
  'Registration_classId_studentId_key',
  'Room_private_identity_unique',
  'Room_public_identity_unique',
  'Student_account_live_unique',
  'Student_email_key',
  'Teacher_account_live_unique',
  'Teacher_email_key',
  'Teacher_pageSlug_key',
  'TeacherRoom_teacherId_roomId_key',
  'WaitlistEntry_waiting_position_key',
] as const;
export type UniqueConstraintName = (typeof UNIQUE_CONSTRAINTS)[number];

export function isUniqueConflictOn(err: unknown, names: readonly UniqueConstraintName[]): boolean {
  const pg = pgErrorOf(err);
  return pg !== null && pg.sqlState === '23505' && pg.constraint !== undefined
    && (names as readonly string[]).includes(pg.constraint);
}
```
If Step 2's reading adds a name, add it to the registry. The registry holds exactly the names some caller passes; re-derive it with `git grep -ohE "isUniqueConflictOn\([a-z]+, \[[^]]*\]" -- src tests`.

Rewrite the docblock to what is true now:
- matched by name, because two tables can share a column set and only the name tells them apart;
- a name match is narrower than a column match, and what a missed name costs depends on whether the site rethrows; link "Database errors" for the shapes;
- the consolidation advice stays, reworded for names;
- delete everything about `meta.target`, the unwrapping, and the measured `{"modelName":"Teacher","target":["accountId"]}`.

Apply the call-site table. Each `rawTarget: err.meta?.target` becomes `constraint: pgErrorOf(err)?.constraint`. The comment at `registrations/route.ts:542` says the check matches `Registration_classId_studentId_key`, and anything else falls through to `withErrorHandler`, which answers 409 and logs `warn` naming the constraint. The P2002 fallback's `detail` changes as listed in Files.

- [ ] **Step 6: Rewrite this task's test files**

- **Fabricated**: `unique-conflict.test.ts` (Step 3), `api-utils.test.ts` and `registrations/route.test.ts` (P2002 `meta: { target }` becomes `knownWithAdapterCause('P2002', pgCause('23505', '...'))`, and any `detail.target` assertion becomes `detail.constraint`), and `api-errors.test.ts` (Step 3).
- **Call sites in tests**:
  - `slot-constraints.test.ts:265,278` and `room-identity-index.test.ts:89,103,118` → `Room_public_identity_unique` / `Room_private_identity_unique`;
  - `waitlist-position-index.test.ts:107` → `WaitlistEntry_waiting_position_key`;
  - `live-profile-unique.test.ts:84,135` → `Teacher_account_live_unique` / `Student_account_live_unique`, whichever table that case writes;
  - `schedule-rule-constraints.test.ts` and `slot-constraints.test.ts` lines asserting `meta.target` → `pgErrorOf(err)?.constraint`;
  - `erased-profile-restart.test.ts:167`: the comment now describes the name match over the partial index.
- `teacher-profile.test.ts`, `admin-grant-constraints.test.ts` and `push-schema.test.ts` assert `code === 'P2002'` only, and `P2002` still arrives. Each gets a "holds" verdict unless the ledger has a row for it.

- [ ] **Step 7: Run green**

Run `pnpm run typecheck`, the files above, and `src/lib/pg-error-sites.test.ts` (unit-sweeps). Restart the worktree app, then run `src/app/api/account/teacher-profile/route-lock-order.test.ts` to confirm the helper extraction changed nothing.

- [ ] **Step 8: Guard bites** (warm the touched route after each mutation and each restore before scoring)

| Break | Expected failure |
|---|---|
| `pgErrorOf`'s 23505 name taken from `cause.constraint.fields` joined | the `Room_private_identity_unique` produced case fails (truncated fields) |
| add `'Room_bogus_unique'` to `UNIQUE_CONSTRAINTS` | the registry test fails, naming `Room_bogus_unique` |
| `rooms/[id]/route.ts:214`: pass `'Room_public_identity_unique'` | `tests/integration/rooms-api.test.ts`, describe "PUT /api/rooms/[id] collides on the slot key (#196)", fails on the code: `UNIQUE_CONFLICT` received, `DUPLICATE_ROOM` expected (the rethrow reaches the fallback 409) |
| `student-profile/route.ts:180`: drop `'Account_email_key'` | the student ticket case fails with 500 (`student profile create: unrecognised unique constraint`) |
| `student-profile/route.ts:168`: drop `'Student_email_key'` | the student double-tap case fails with 500 |
| `student-profile/route.ts:168`: drop `'Student_account_live_unique'` | the student same-account, different-email case fails with 500 |
| `teacher-profile` `isSessionCollision`: drop `'Teacher_account_live_unique'` | the teacher same-account, different-email case fails with 500 |
| `teacher-profile` `isSessionCollision`: drop `'Teacher_email_key'` | `teacher-profile/route-lock-order.test.ts:133` ("answers unchanged ...") fails with 500 |
| `invitations.ts:402`: drop the name (pass `'Account_email_key'`) | the invitations case rejects with `invitation create: unrecognised unique constraint` |
| `teacher-rooms/route.ts:117`: drop the name (pass `'Account_email_key'`) | the teacher-rooms case fails with 500 |

Restore each break and re-run green. Record the failure texts.

- [ ] **Step 9: Docs, window gate, commit**

`docs/data-model.md:1105`: the room-identity paragraph describes matching by the index name, and the unwrapping goes. Then run "The window gate" with `N=7` and category `U`.
```bash
git add src/lib/unique-conflict.ts src/lib/unique-conflict.test.ts src/lib/api-errors.ts src/lib/api-errors.test.ts \
  src/lib/pg-error.test.ts src/lib/pg-error-sites.test.ts tests/holder-race.ts vitest.tiers.ts docs/data-model.md \
  'src/app/api/account/teacher-profile/route-lock-order.test.ts' \
  'src/app/api/account/student-profile/route.ts' 'src/app/api/account/teacher-profile/route.ts' \
  src/app/api/registrations/route.ts 'src/app/api/rooms/[id]/publish/route.ts' 'src/app/api/rooms/[id]/route.ts' \
  src/app/api/rooms/route.ts src/app/api/teacher-rooms/route.ts 'src/app/api/teachers/[id]/route.ts' \
  src/services/class-lifecycle.ts src/services/invitations.ts src/lib/api-utils.test.ts \
  src/app/api/registrations/route.test.ts src/services/slot-constraints.test.ts src/services/waitlist-position-index.test.ts \
  src/services/schedule-rule-constraints.test.ts tests/integration/live-profile-unique.test.ts \
  tests/integration/room-identity-index.test.ts tests/integration/erased-profile-restart.test.ts
# plus any further U-row file from the ledger, by exact path
git commit -m "fix: unique conflicts are matched by constraint name (#885)

Suite red by design (red window, plan Tasks 4-9): T S."
```

---

### Task 8: Transient kinds on structured fields, `P2024` removed — turns T green

**Files:**
- Modify: `src/lib/api-errors.ts`:
  - `transientKindShallow` reads `pgErrorOf`;
  - `P2024` leaves `TRANSIENT_PRISMA_CODE_KIND`;
  - the `transientDbFailure` docblock's shape quotes become a link;
  - `classifyApiError`'s comment "a `P2024`/`P2028` is a `PrismaClientKnownRequestError` too" becomes "a `P2028` is ...".
- Create: `src/lib/db-transient-shapes.test.ts`. Its header carries the marker `@serial-tier lock-contention` with its reason. Append it to `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`.
- Modify (`P2024` comment mentions): `src/app/api/account/route.ts:37`, `src/services/waitlist-reconciliation.ts:493`, `src/services/class-template-lifecycle.ts:1122`, `src/services/studio-class-template-lifecycle.ts:753`
- **Tests fabricating the old shapes for this classifier** (from the census; this task owns them): `src/lib/api-errors.test.ts` (the `55P03` / `40P01` framings and the `P2024` cases), `src/app/api/account/route.test.ts`, `src/app/api/cron/daily-cleanup/route.test.ts`, `src/app/api/registrations/[id]/promote-after-cancel.test.ts`, `src/app/api/registrations/route.test.ts` (the `P2024` case), `src/app/api/waitlist/route.test.ts`, `src/services/class-generator.test.ts`, `src/services/class-template-lifecycle.test.ts`, `src/services/studio-class-generator.test.ts`, `src/services/studio-class-template-lifecycle.test.ts`, `src/services/waitlist-reconciliation.test.ts`, `src/services/waitlist-retention.test.ts`, `src/services/waitlist.test.ts`, `src/services/gdpr.test.ts`
- **Produced-error tests** (from the census and the §7 "14 files" table; the ledger's T rows are authoritative): `src/app/api/registrations/route-lock-order.test.ts` (except `:628`, which is an S row), `src/lib/db-locks-lock-order.test.ts`, `src/lib/db-locks.test.ts`, `src/services/class-lifecycle-lock-order.test.ts`, `src/services/class-template-lifecycle-lock-order.test.ts`, `src/services/class-transitions.test.ts`, `src/services/currency-switch-lock-order.test.ts`, `src/services/gdpr-lock-order.test.ts`, `src/services/invitations-lock-order.test.ts`, `src/services/notification-retention.test.ts` (the `40P01` line), `src/services/room-archive-lock-order.test.ts`, `src/services/room-switch-lock-order.test.ts`, `src/services/waitlist-lock-order.test.ts`
- Modify (docs): `docs/technical-architecture.md` "Database errors" (the `pool_exhausted` / `tx_budget` split, measured), and `docs/lock-order.md:1230-1244` (the present-tense claim about `40P01` arriving as an Unknown error)

**Interfaces:**
- Consumes: `pgErrorOf`, `isPgPoolTimeout`, `pgPoolTimeout`, `knownWithAdapterCause`, `driverAdapterError`, `pgCause`.
- Produces: the exports are unchanged (`transientDbFailure`, `isTransientDbError`, `isLockTimeout`, `TransientKind`). `TRANSIENT_PRISMA_CODE_KIND` becomes `{ P2028 → tx_budget, P2034 → serialization }`.

- [ ] **Step 1: Write the failing produced matrix** `src/lib/db-transient-shapes.test.ts` (§7's table)

The header is one paragraph: the marker `@serial-tier lock-contention`, and the reason (it asserts on lock timing and on `lock_timeout` / `maxWait` bounds, which tier contention can stretch). Each case asserts `transientDbFailure(err)` → `{ kind, level }`, `classifyApiError(err)` → `503` with `detail.transientKind`, and `pgErrorOf(err)?.sqlState` where §7 names one.

```ts
it('pool_exhausted: typed, raw and batch calls behind a held connection', async () => {
  const db = createPrismaClient({ poolMax: 1, connectionTimeoutMs: 200 });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const holding = new Promise<void>((r) => { started = r; });
  const holder = db.$transaction(async (tx) => { await tx.$queryRaw`SELECT 1`; started(); await held; }, { timeout: 10_000, maxWait: 5_000 });
  try {
    await holding;
    const typed = await db.teacher.count().then(() => null, (e: unknown) => e);
    const raw = await db.$queryRaw`SELECT 1`.then(() => null, (e: unknown) => e);
    const batch = await db.$transaction([db.teacher.count()]).then(() => null, (e: unknown) => e);
    for (const err of [typed, raw, batch]) {
      expect(isPgPoolTimeout(err)).toBe(true);
      expect(transientDbFailure(err)).toEqual({ kind: 'pool_exhausted', level: 'error' });
      expect(classifyApiError(err)).toMatchObject({ status: 503, detail: { transientKind: 'pool_exhausted' } });
    }
    // fidelity for the helper (spec defect 3)
    expect(Object.keys(pgPoolTimeout()).sort()).toEqual(Object.keys(typed as object).sort());
  } finally {
    release();
    await holder;
    await db.$disconnect();
  }
});
```

The other cases:
- **lock_timeout**: a holder transaction takes `SELECT ... FOR UPDATE` on a seeded row. The victim transaction runs `SET LOCAL lock_timeout = '100ms'`, then a typed `update`, which gives a `DriverAdapterError` with `55P03`. A raw `UPDATE` in the same setup gives `P2010` with `55P03`. Both classify as `lock_timeout` at `warn`.
- **deadlock, run twice** (I-5): two transactions lock rows A and B in opposite order behind a barrier. In run 1 both transactions use typed `update`s, and the killed one throws a `DriverAdapterError` with `40P01`. In run 2 both use raw `UPDATE`s, and the killed one throws `P2010` with `40P01`. Each run asserts `deadlock` at `error` on whichever transaction Postgres killed, and that exactly one was killed.
- **serialization**: a transaction with `isolationLevel: 'RepeatableRead'` reads a row, which takes its snapshot. Another client updates and commits that row. The transaction's typed update then gives `P2034` with cause `originalCode: '40001'`. A raw `UPDATE` gives `P2010` with `40001`. Both classify as `serialization` at `warn`.
- **tx_budget**: `timeout: 100` with a `pg_sleep(0.5)` inside gives `P2028` with meta `timeout` and `timeTaken`. `maxWait: 300` behind a `poolMax: 1` holder gives `P2028` with `meta {}`. Both classify as `tx_budget` at `warn`. The `txError` assertion comes in Task 9: an S row.
- **not transient**: `SET LOCAL statement_timeout = '50ms'` then `pg_sleep(1)` gives `57014`. `transientDbFailure` is `null`, and `classifyApiError` returns 500.

Append `'src/lib/db-transient-shapes.test.ts'` to `LOCK_CONTENTION_TESTS`.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec vitest run --project unit-sweeps src/lib/db-transient-shapes.test.ts`
Expected: FAIL. The typed `55P03` and `40P01` cases answer `null` (500). The raw cases may already pass through the framing. `pool_exhausted` and `serialization` already pass, from Task 3.

- [ ] **Step 3: Implement**

```ts
const TRANSIENT_PRISMA_CODE_KIND: ReadonlyMap<string, TransientKind> = new Map([
  ['P2028', 'tx_budget'],
  ['P2034', 'serialization'],
]);

function transientKindShallow(error: unknown): TransientKind | null {
  const sqlState = pgErrorOf(error)?.sqlState;
  if (sqlState !== undefined) {
    const kind = TRANSIENT_SQLSTATE_KIND.get(sqlState);
    if (kind) return kind;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const kind = TRANSIENT_PRISMA_CODE_KIND.get(error.code);
    if (kind) return kind;
  }
  return isPgPoolTimeout(error) ? 'pool_exhausted' : null;
}
```
`MAX_CAUSE_DEPTH` and the walk are unchanged. The `TransientKind` docblock drops `P2024`. In the comment sites (`account/route.ts:37`, `waitlist-reconciliation.ts:493`, `class-template-lifecycle.ts:1122`, `studio-class-template-lifecycle.ts:753`), `P2024` becomes "pool exhaustion (`pool_exhausted`)".

- [ ] **Step 4: Rewrite this task's test files**

**Fabricated:**
- `P2024` becomes `pgPoolTimeout()`.
- A fabricated `P2028` stays a Known `P2028` and loses any `meta.error` text.
- Fabricated framings of `55P03` / `40P01` become `driverAdapterError(pgCause('55P03', 'canceling statement due to lock timeout'))` or `knownWithAdapterCause('P2010', pgCause(...))`. Where the test is about the matcher, cover both shapes.

**Produced** (the §7 table, verdict by verdict):
- `String(err)` matched against `/55P03/`, `/40P01|deadlock/` or `/55P03|lock timeout/`, or `.includes('55P03')`, becomes `transientDbFailure(err)?.kind === 'lock_timeout'` / `'deadlock'`, or `isLockTimeout(err)`.
- `db-locks.test.ts:612,660,967-974` becomes `pgErrorOf(err)?.sqlState === '55P03'`.
- The negatives become `expect(transientDbFailure(err)?.kind).not.toBe('deadlock')` (or `'lock_timeout'`). They are `db-locks-lock-order.test.ts:525-526`, `gdpr-lock-order.test.ts:860-861,2673-2674` and `room-archive-lock-order.test.ts:405,435`.
- `registrations/route-lock-order.test.ts:628` asserts the parsed log line's `err.sqlState`. It is an S row and is left for Task 9.

- [ ] **Step 5: Run green**

Run `src/lib/db-transient-shapes.test.ts` and `src/lib/api-errors.test.ts`.

- [ ] **Step 6: Guard bites**, including the extractor bites over the whole matrix (I-8)

Run each against `src/lib/pg-error.test.ts`, `src/lib/db-transient-shapes.test.ts` and `src/lib/pg-error-sites.test.ts` together.

| Break | Expected failure |
|---|---|
| `pgErrorOf` reads `cause.code` instead of `originalCode` | typed and raw `40001` fail (`null` where `serialization` is expected, because that kind has no `code`); every `23505` and `23503` case fails |
| delete `adapterCauseOf`'s `DriverAdapterError` branch | every typed `23514`, `23P01`, `55P03` and `40P01` case fails (500 where 409 or 503 is expected) |
| delete `adapterCauseOf`'s Known branch | every raw case fails, as does every `P2002`, `P2003` and `P2034` case (the typed `40001` is still `serialization` through the code map; the raw one is not) |
| change one character of `PG_POOL_TIMEOUT_MESSAGE` | the `pool_exhausted` case fails: `isPgPoolTimeout` false, 500 instead of 503 |
| `transientKindShallow`: skip the `pgErrorOf` step | every typed `55P03` and `40P01` case fails (500) |

Restore each break and re-run green. Record the failure texts. If a row's failure differs from the spec's expected failure (spec:974-976), report the difference.

- [ ] **Step 7: Docs, window gate, commit**

- "Database errors": say what `pool_exhausted` covers, as measured. It covers raw, model and batch calls, and an interactive transaction too: `maxWait` is judged only once the pool hands over a connection. An interactive transaction whose wait outlives the pool bound is `pool_exhausted`; one whose connection is freed within the pool bound but after `maxWait` is `P2028` with `meta {}`, `tx_budget`. With the defaults (`maxWait` 2 s, pool bound 10 s), a wait ending between 2 s and 10 s is `tx_budget` and one reaching 10 s is `pool_exhausted`.
- `docs/lock-order.md:1230-1244`: a typed `40P01` is a `DriverAdapterError` whose cause carries `originalCode: '40P01'`, and `transientDbFailure` reads it there (link "Database errors"). The dated block near `:3128` stays.

Run "The window gate" with `N=8` and category `T`.
```bash
git add src/lib/api-errors.ts src/lib/api-errors.test.ts src/lib/db-transient-shapes.test.ts vitest.tiers.ts \
  src/app/api/account/route.ts src/services/waitlist-reconciliation.ts src/services/class-template-lifecycle.ts \
  src/services/studio-class-template-lifecycle.ts docs/technical-architecture.md docs/lock-order.md \
  src/app/api/account/route.test.ts src/app/api/cron/daily-cleanup/route.test.ts \
  'src/app/api/registrations/[id]/promote-after-cancel.test.ts' src/app/api/registrations/route.test.ts \
  src/app/api/waitlist/route.test.ts src/services/class-generator.test.ts src/services/class-template-lifecycle.test.ts \
  src/services/studio-class-generator.test.ts src/services/studio-class-template-lifecycle.test.ts \
  src/services/waitlist-reconciliation.test.ts src/services/waitlist-retention.test.ts src/services/waitlist.test.ts \
  src/services/gdpr.test.ts src/app/api/registrations/route-lock-order.test.ts src/lib/db-locks-lock-order.test.ts \
  src/lib/db-locks.test.ts src/services/class-lifecycle-lock-order.test.ts src/services/class-template-lifecycle-lock-order.test.ts \
  src/services/class-transitions.test.ts src/services/currency-switch-lock-order.test.ts src/services/gdpr-lock-order.test.ts \
  src/services/invitations-lock-order.test.ts src/services/notification-retention.test.ts \
  src/services/room-archive-lock-order.test.ts src/services/room-switch-lock-order.test.ts src/services/waitlist-lock-order.test.ts
# plus any further T-row file from the ledger, by exact path
git commit -m "fix: transient kinds read the adapter's SQLSTATE; P2024 cannot arise (#885)

Suite red by design (red window, plan Tasks 4-9): S."
```

---

### Task 9: The serializer's facets (D6) — turns S green, closes the window

**Files:**
- Modify: `src/lib/log-serializers.ts`
- **Tests fabricating the old shapes for the serializer** (from the census; this task owns them): `src/lib/log-serializers.test.ts` (the `PostgresError`, `meta.code`, `meta.target`, `meta.error` and `connection_limit` fabrications), `src/services/degradation-digest.test.ts` (its `P2010` `meta` fabrication; `describeFailure` itself needs no code change)
- **S rows carried here**: the log-facet `it`s in `src/lib/pg-error.test.ts`, `tests/integration/log-redaction.test.ts`, `src/app/api/registrations/route-lock-order.test.ts:628`, and the `txError` assertions in `src/lib/db-transient-shapes.test.ts`
- Verdict only: `src/lib/prisma-config.test.ts`. Its `P1001` concerns the CLI's `prisma.config.ts`; it holds unless the ledger lists it.

**Interfaces:**
- Consumes: `pgErrorOf`, `adapterKindOf`, `AdapterKind`.
- Produces: `SerializedErr` drops `connectorKind` and gains `adapterKind?: AdapterKind`. `TxErrorKind` becomes `'expired' | 'other'`. `SerializedPrismaMeta` drops `target` and `connection_limit`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/log-redaction.test.ts`, extended with real errors:
```ts
it('a typed trigger raise names its trigger and row, and leaks neither its message nor the row id', async () => {
  const { classId } = await completedClass();          // via tests/class-fixtures.ts
  const out = await logged(() => prisma.class.update({ where: { id: classId }, data: { status: 'open' } }), classId);
  expect(out.err).toMatchObject({ name: 'DriverAdapterError', sqlState: '23514', trigger: 'status', rowIds: [classId] });
  expect(out.err.message).toBe('Driver adapter error (detail withheld from the log)');
  expect(JSON.stringify(out.err)).not.toContain('which is terminal');
});
```
Update `a CHECK violation names its constraint`: assert also that `'Failing row contains'` and the primary message are absent, and that the name is `DriverAdapterError`.

`src/lib/log-serializers.test.ts`: rewrite every library-engine fabrication to the helper. Cases:
- `sqlState` and `constraint` on Known `P2002` / `P2003` / `P2010` and on typed 23514 / 23P01;
- `trigger` and `rowIds` from `pg.message`, only when `23514` has no `constraint`;
- a constraint name outside `/^[A-Za-z0-9_]+$/` is not logged (the facet keeps its old charset guarantee);
- `adapterKind: 'DatabaseNotReachable'` on a Known `P2010` with no `originalCode`;
- `txError` is `'expired'` for `meta { timeout: 100, timeTaken: 512 }` and `'other'` for `meta {}`;
- `META_KEYS` drops `target` and `connection_limit`.

`db-transient-shapes.test.ts` tx_budget case: `serializeErr(err).txError` is `'expired'` / `'other'`.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec vitest run --project unit src/lib/log-serializers.test.ts`, then `pnpm exec vitest run --project integration tests/integration/log-redaction.test.ts` (after `worktree:up`).
Expected: FAIL. `sqlState`, `constraint`, `trigger` and `adapterKind` are absent from adapter errors, and `txError` reads `meta.error`.

- [ ] **Step 3: Implement**

In `withheld()`, replace `liftSqlState` and the `CONSTRAINT` / `PG_MESSAGE` / `CONNECTOR_KIND` reads:
```ts
const pg = pgErrorOf(err);
if (pg !== null) {
  out.sqlState = pg.sqlState;
  if (pg.constraint !== undefined && CONSTRAINT_NAME.test(pg.constraint)) out.constraint = pg.constraint;
  if (pg.sqlState === '23514' && pg.constraint === undefined) {
    const trigger = TERMINAL_TRIGGERS.find((key) => pg.message.includes(TERMINAL_TRIGGER_TAILS[key]));
    if (trigger !== undefined) {
      out.trigger = trigger;
      const ids = [...new Set(pg.message.match(UUID) ?? [])].slice(0, MAX_ROW_IDS);
      if (ids.length > 0) out.rowIds = Object.freeze(ids);
    }
  }
} else {
  const kind = adapterKindOf(err);
  if (kind !== undefined) out.adapterKind = kind;
}
```
with `const CONSTRAINT_NAME = /^[A-Za-z0-9_]+$/;`. Then:
- `txErrorKind(meta)` returns `'expired'` when `field(meta, 'timeout')` and `field(meta, 'timeTaken')` are both finite numbers, else `'other'`.
- `META_KEYS`: remove `target` and `connection_limit`, from the interface too.
- Delete `PG_CODE`, `CONSTRAINT`, `CONSTRAINT_SQLSTATES`, `CONNECTOR_KIND`, `CONNECTOR_KINDS`, `PG_MESSAGE` and `liftSqlState`, and `SQLSTATE` if it becomes unused.
- The module docblock says that a withheld error's facets are lifted through `pgErrorOf` (link "Database errors").

- [ ] **Step 4: Run green**

Run `src/lib/log-serializers.test.ts`, `src/lib/pg-error.test.ts`, `src/lib/db-transient-shapes.test.ts`, `src/services/degradation-digest.test.ts`, and the integration redaction and route-lock-order files.

- [ ] **Step 5: Guard bites**

| Break | Expected failure |
|---|---|
| remove the `DriverAdapterError` arm from `withheldClass` | the redaction test fails: the row id appears |
| walk a non-Error cause under a withheld error again | the redaction test fails: the primary message appears under `cause` |
| `trigger` read from `out.message` instead of `pg.message` | the trigger case fails (no `trigger`) |
| `txErrorKind` returns `'other'` unconditionally | the `expired` case fails |

Restore each break and re-run green. Record the failure texts.

- [ ] **Step 6: Close the window: the whole suite green**

Run "The window gate" with `N=9` and category `S`. Then:
```bash
pnpm run verify 2>&1 | tee $S/run-t9-verify.log
pnpm exec playwright test 2>&1 | tee $S/run-t9-e2e.log
```
Expected: `$S/red-9.tsv` is empty, `verify` exits 0, and Playwright is green, including the e2e rows Task 4 fixed. A failure here that the ledger did not foresee gets a root-cause investigation before anything else (superpowers:systematic-debugging). Do not commit around it.

- [ ] **Step 7: Commit**

```bash
git add src/lib/log-serializers.ts src/lib/log-serializers.test.ts src/services/degradation-digest.test.ts \
  tests/integration/log-redaction.test.ts src/lib/pg-error.test.ts src/lib/db-transient-shapes.test.ts \
  src/app/api/registrations/route-lock-order.test.ts
# plus any further S-row file from the ledger, by exact path
git commit -m "fix: the log serializer lifts adapter error facets structurally (#885)"
```

---

### Task 10: Bundling, both images, the CI probes (D7, D9, §6 items 2–7)

**Files:**
- Rename: `scripts/prisma-engine-probe.cjs` → `scripts/prisma-client-probe.cjs` (`git mv`)
- Modify: `scripts/check-reserved-slugs.ts`
- Modify: `.github/workflows/ci.yml`: the runner probe step, the reserved-slug step, the docker-build job's header comment, and both "App log (on failure)" greps
- Modify: `Dockerfile` (the migrate stage's comment on `src/lib/prisma-client.ts`)
- Modify (docs): in `docs/supply-chain.md`, "Prisma's engine in the images". The heading is kept, so links stay valid: the migrate image still carries the schema engine. In `docs/technical-architecture.md`, "Where Prisma comes from": the `.node` trace paragraph (`:1375`) and the `runtime/library` external sentence (`:1432`).

**Interfaces:** none in TypeScript. The probe's success line is `client loaded; database unreachable with ENETUNREACH as expected`, the exact string ci.yml greps for.

- [ ] **Step 1: Build measurements** (§6 items 2–3)

```bash
pnpm run build 2>&1 | tee $S/build-t10.log
grep -nE "pg-native|query_compiler" $S/build-t10.log || echo "(none)"
find .next-build/standalone -name '*.node'
find .next-build/standalone/node_modules -maxdepth 4 -type d -path '*pg*'
find .next-build/standalone -name 'query_compiler_bg.postgresql*'
grep -rhoE '@prisma/client[^"]*' .next-build/server --include='*.js' | sed -E 's/-[0-9a-f]{16}//' | sort -u
grep -nE '"(pg|@prisma/client)"' node_modules/next/dist/lib/server-external-packages.jsonc
```
Expected:
- no `*.node`;
- `pg`, `pg-pool`, `pg-protocol`, `pg-types` and `pg-connection-string` present;
- the query compiler's `.js` and `.wasm-base64.js` present;
- the externals line includes `@prisma/client/runtime/client`;
- the jsonc's lines 16 and 67 print.

Record all of it. If `pg` is missing from the standalone tree, stop: D9's "no `serverExternalPackages`" is falsified, and the spec owner decides.

Run the standalone server against the real dev database, on port 3998. The DB must hold the seed's teacher `ivo`:
```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_dev_issue_885 -Atc "SELECT \"pageSlug\" FROM \"Teacher\" WHERE \"pageSlug\" = 'ivo'"   # empty → run: pnpm run db:seed
cp -r .next-build/static .next-build/standalone/.next-build/static
[ -d public ] && cp -r public .next-build/standalone/public || true
DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')" PORT=3998 HOSTNAME=127.0.0.1 \
  node .next-build/standalone/server.js > $S/standalone.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3998/api/health; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3998/ivo
kill %1
```
Expected: `{"status":"ok","db":"up"}`, and `200` for `/ivo`, the public teacher page, which runs model queries. Record both.

- [ ] **Step 2: Build the runner and migrate images** (§6 items 5–7)

```bash
docker build -t fairyoga .
docker build --target migrate -t fairyoga-migrate .
docker image inspect -f '{{.Size}}' fairyoga fairyoga-migrate
```
Record the sizes beside Task 0's.

- [ ] **Step 3: Measure what the runner logs under `--network none` before writing any probe string**

```bash
docker run --rm --network none -e DATABASE_URL='postgresql://u:p@203.0.113.1:5432/none' -e PORT=3999 -e HOSTNAME=127.0.0.1 \
  --entrypoint sh fairyoga -c 'node server.js & sleep 4; wget -qO- http://127.0.0.1:3999/api/health; sleep 1; kill %1' 2>&1 | tee $S/runner-netnone.log
grep 'health check: database probe failed' $S/runner-netnone.log
```
Expected (spec D7): the line's `err.type` is `PrismaClientKnownRequestError`, and its `err.code` is `ENETUNREACH`. If the image lacks `wget`, use the old probe's `fetch` loop. **If either string differs, stop and report it.** The committed strings come from this measurement.

- [ ] **Step 4: Write `scripts/prisma-client-probe.cjs`**

Run `git mv scripts/prisma-engine-probe.cjs scripts/prisma-client-probe.cjs`, then rewrite it:
- **Header.** Say what the probe proves now: the bundle constructed a client, the client handed the query to the adapter, and pg tried the network. It still boots `/app/server.js` and waits for the `health check: database probe failed` line. It reads `err.type` and `err.code` from the JSON line, never the message, which is withheld. The reason links `docs/supply-chain.md` "Prisma's engine in the images".
- **Target.** `UNREACHABLE = 'postgresql://u:p@203.0.113.1:5432/none'`, with no `connect_timeout`.
- **Reader.** `probeFailureMessage()` becomes `probeFailure()`, returning `{ type, code }` or `null`.
- **Verdicts, in order:**
  ```js
  if (failure.type === 'PrismaClientKnownRequestError' && failure.code === 'ENETUNREACH') {
    finish(0, 'client loaded; database unreachable with ENETUNREACH as expected');
  } else if (output.includes('Failed to load external module')) {
    finish(1, 'the Prisma client could not load a module it imports lazily (the query compiler): the bundle is missing it');
  } else {
    finish(1, `the health probe failed with type ${failure.type} and code ${failure.code}, expected PrismaClientKnownRequestError and ENETUNREACH`);
  }
  ```
  A missing module carries no `code`: Turbopack wraps Node's error in a plain `Error` whose text, in the server's unwithheld output, is `Failed to load external module …`. That text is what both named failures key on.
- **Import failures.** While awaiting the first HTTP response and while waiting for the probe line, also check `output.includes('Failed to load external module')`. If it appears before any probe line, call `finish(1, 'a module failed to load at import, before the health route ran')`. A missing `pg` takes this branch: the server stops at instrumentation-hook load and never answers HTTP.
- **Prefix.** Every `prisma-engine-probe:` prefix becomes `prisma-client-probe:`.

- [ ] **Step 5: `scripts/check-reserved-slugs.ts`**

Delete the `$connect()` call and its comment. The header's note on the CI step says an unreachable database now surfaces from the gate's own query, as the errno code `console.error` prints.

- [ ] **Step 6: Measure the migrate image's gate output**

Rebuild first: `docker build --target migrate -t fairyoga-migrate .`
```bash
set +e
OUT="$(docker run --rm --network none -e DATABASE_URL='postgresql://u:p@203.0.113.1:5432/none' fairyoga-migrate pnpm exec tsx scripts/check-reserved-slugs.ts 2>&1)"; RC=$?
set -e
echo "$OUT" | tee $S/migrate-slug.log; echo "RC=$RC"
```
Expected: the output contains `ENETUNREACH`, and `RC=1`. If not, stop and report the output.

- [ ] **Step 7: ci.yml**

- The step "Prisma query engine loads in the runner image" becomes **"Prisma client loads in the runner image"**:
  ```yaml
  - name: Prisma client loads in the runner image
    run: |
      OUT="$(docker run --rm --network none -i --entrypoint node fairyoga - < scripts/prisma-client-probe.cjs 2>&1)" || true
      echo "$OUT"
      grep -q 'client loaded; database unreachable with ENETUNREACH as expected' <<< "$OUT" || { echo "::error::client probe did not report its success line - the Prisma client or its driver did not load"; exit 1; }
  ```
  Rewrite its comment block for the client probe.
- "Reserved-slug check loads in the migration image":
  - its `DATABASE_URL` drops `?connect_timeout=3`, because pg ignores it (§2 item 10);
  - the check becomes `grep -q 'ENETUNREACH'`;
  - the error becomes `::error::the reserved-slug check did not reach the network - it failed to load in the migration image`;
  - its comment's "Reaching P1001" becomes "Reaching ENETUNREACH".
- The docker-build job's header comment: "Prisma's engine loads in each" becomes "the Prisma client loads in the runner and the schema engine in the migrate image".
- Both "App log (on failure)" greps: `'contention|lock_not_available|deadlock|55P03|40P01|40001|pool_exhausted|P2028|P2034'`.
- "Prisma schema engine loads in the migration image" is unchanged, including its `connect_timeout=3`, which the CLI honours.

`Dockerfile`: the migrate stage's comment says `src/lib/prisma-client.ts` imports the generated client, `@prisma/adapter-pg` and `node:os`, all present because the stage is built `FROM deps`. No COPY changes.

- [ ] **Step 8: Run all three docker-build steps exactly as ci.yml does, then the guard bites** (§6 items 4–6)

Rebuild the runner (`docker build -t fairyoga .`). Paste each of the three docker-build steps' `run:` blocks verbatim into `bash -e`. Expected: each one passes.

| Break | How | Expected failure |
|---|---|---|
| runner without `pg` (§6 5a) | a scratch Dockerfile, `FROM fairyoga` + `RUN rm -rf "$(readlink -f /app/.next-build/node_modules/pg-*)" /app/node_modules/pg /app/node_modules/.pnpm/pg@8.23.1`, tagged `fairyoga:885-nopg` (the bundle's hashed `pg-*` external resolves to `.pnpm/pg@8.23.1`, so removing `node_modules/pg` alone leaves the probe passing); run the probe against it | the probe exits 1 with the import failure. Record its exact text |
| runner without the query compiler (§6 4, 5b) | `FROM fairyoga` + `RUN find /app -name 'query_compiler_bg.postgresql.wasm-base64.js' -delete`, tagged `fairyoga:885-nowasm` | the probe exits 1 with the lazy-module failure, keyed on `Failed to load external module`. **If the probe passes, stop**: §6 item 4's fallback is then required, and the spec owner decides it |
| migrate image without the gate's import (§6 6) | delete the `COPY src/services/reserved-slug-holders.ts` line, rebuild as `fairyoga-migrate:885-bite`, run the step's command | the output has no `ENETUNREACH` (a module-not-found), and the step's `grep` fails |

Restore the Dockerfile and remove the scratch images. Record every failure text in `$S/measurements.md`.

- [ ] **Step 9: Idle RSS after** (§6 item 7)

Run Task 0 Step 4's commands against the new `fairyoga` image, and record the figure beside the "before".

- [ ] **Step 10: Docs**

- `docs/supply-chain.md`, "Prisma's engine in the images":
  - what the runner carries now: no `.node`; the client runtime, the query compiler's `.js` and `.wasm-base64.js`, and `pg` with its dependencies;
  - what the renamed probe proves, and its failure modes with their measured texts;
  - the re-derivation commands from Step 1;
  - the measured image sizes before and after;
  - that `ENETUNREACH` was measured on arm64.

  The amd64 confirmation is **not** written here. Task 13 adds it after CI shows it.
- `docs/technical-architecture.md`: replace the `.node` trace paragraph (`:1375`) and the `runtime/library` external sentence (`:1432`) with the measured externals line and the standalone contents.

- [ ] **Step 11: Commit**

```bash
git add scripts/prisma-client-probe.cjs scripts/prisma-engine-probe.cjs scripts/check-reserved-slugs.ts \
  .github/workflows/ci.yml Dockerfile docs/supply-chain.md docs/technical-architecture.md
git commit -m "ci: the runner probe asserts the client reached the network; the slug gate's errno (#885)"
```

---

### Task 11: Sweeps (§8, risk 8, Review Focus 4 and 5, census reconciliation)

**Files:** whatever the verdicts require. List each fix in the task report with its verdict.

**Interfaces:** none.

- [ ] **Step 1: Removed names, one verdict per hit**

```bash
git grep -nE "P2024|meta(\?)?\.(target|constraint|code|error)\b|PostgresError|Code: \`|connection_limit|pool_timeout|connect_timeout|query engine|Query Engine|libquery|runtime/library|connectorKind|CONNECTOR_KIND|start_timeout|extractColumnIdentifier|PrismaClientUnknownRequestError|prisma-engine-probe" -- ':!pnpm-lock.yaml' ':!src/generated' > $S/sweep-names.txt; wc -l < $S/sweep-names.txt
```
Write a verdict for each line in the report: "fixed", saying how, or "legitimate survivor", saying why. Expected survivors:
- dated measurement blocks in `docs/`;
- specs and plans under `docs/superpowers/`;
- ci.yml's `connect_timeout=3` in the **"Prisma schema engine loads in the migration image"** step only (`prisma migrate status`; the CLI honours it). The reserved-slug step dropped it in Task 10;
- `PrismaClientUnknownRequestError` in the serializer's withheld set and in `pg-error.test.ts`'s negative case.

A live description of the old shape outside a dated block is "fixed".

- [ ] **Step 2: The SQL-generation claims, measured on C+A** (§8 table, §6 item 11)

```bash
git grep -nEi "prisma (splits|issues|emits|runs|sends|reads|selects|wraps|implements|compiles|generates)|the engine (issues|emits|runs|sends|wraps|reads)" -- src docs/lock-order.md docs/technical-architecture.md docs/data-model.md ':!src/generated' | tee $S/sweep-sql.txt | wc -l
```
Expected: 21 lines or more (the floor). Take each line §8's table marks "to measure", plus any line added since. For each one, write a scratch script on `createPrismaClient({ log: [{ emit: 'event', level: 'query' }] })` that prints each statement, as `$S/rev/upsert.ts` does. Run the exact Prisma call the claim is about, and compare. Per line, record the claim, the captured SQL, and the verdict: "true", or "false → rewritten to …". Also read the `docs/lock-order.md` passages on upserts, nested writes and `skipDuplicates`, and give each a verdict the same way.

A claim that is false **and load-bearing** is a correctness question, not a comment fix: `roster-link.ts:27`, `invitations.ts:1656`, `rule-lifecycle.ts:559`, `student-profile/route.ts:104`, `auth/account.ts:61`, `gdpr.ts:1688`. Stop and report it with the captured SQL.

- [ ] **Step 3: Unbounded `in:` lists** (risk 8, Review Focus 5)

```bash
git grep -nE "(^|[^A-Za-z_])in: [A-Za-z_.]+" -- src ':!src/generated' ':!*.test.ts' | tee $S/sweep-in.txt | wc -l   # 45 at spec time
```
For each line, record the list's source and its largest realistic size (per-tenant, per-class, or platform-wide), and one of three verdicts:
- "bounded by …";
- "paged by `readInPages`";
- "can exceed 32,766 bound parameters in a statement Prisma does not split / 21,844 composite parents → fixed or filed".

A platform-wide unpaged list is a live defect (solve-issue §7's floor). If it is a sweep, bound it with `readInPages` or `readInSlices`; otherwise report it.

- [ ] **Step 4: `name` / `char` columns on production raw paths** (Review Focus 4)

```bash
python3 -I $S/scan_name_cols.py $(git ls-files 'src/**/*.ts' 'scripts/**/*.ts' 'src/*.ts' | grep -v '\.test\.ts$')
git grep -nE "\\\$queryRaw(Unsafe)?" -- src scripts ':!*.test.ts' ':!src/generated'
```
Read every hit that selects from `pg_catalog`, `information_schema` or a `pg_*` view, or that returns a column whose type could be `name`, `char`, `void` or a range. For each, record the output column types and the verdict: "safe", or "cast `::text` added". The scanner cannot see multi-line SQL; it only orders the reading.

- [ ] **Step 5: The census files against the diff**

```bash
sh $S/rev2/census-tests.sh > $S/census-now.txt; wc -l < $S/census-now.txt
git diff --name-only main...HEAD > $S/changed.txt
comm -23 <(sort $S/census-now.txt) <(sort $S/changed.txt)
```
`census-tests.sh` greps the current tree, so it now lists the files that **still** match its patterns. Every file `comm` prints is a census file the branch did not touch, and each needs a verdict: "holds: asserts only `code === 'P2002'`, which still arrives", or "missed → fixed now". Then check the §7 "14 files" table: each row's file is in `$S/changed.txt` or has a verdict.

- [ ] **Step 6: Descriptions, not names**

Read the whole docblock of every function this branch touched (`git diff main...HEAD --stat`, then each function within the changed lines). That covers:
- `createPrismaClient` and `poolConfigFor`;
- every matcher, `transientDbFailure` and its maps, and `classifyApiError`'s branch comments;
- `serializeErr`'s helpers;
- `isUniqueConflictOn`, `lowStackClient`, `isStackDepthError`, and the constant in `readInPages`'s module;
- `raceBehindHolder`;
- the probe header and `check-reserved-slugs.ts`'s header.

A sentence that describes the library engine, gives a count, or states a fact about another module is rewritten or moved to `docs/`.

- [ ] **Step 7: Re-run what the fixes touched, then commit**

Run the tests of the touched files, then `pnpm run typecheck && pnpm run lint`.
```bash
git add <every fixed file, by exact path>
git commit -m "docs: sweep the engine's names and SQL claims after the adapter switch (#885)"
```
If the sweeps fix nothing, there is no commit, and the report says so.

---

### Task 12: Final verification

**Files:** none changed. If a step fails, the fix goes in its own task-sized commit, and this task restarts.

- [ ] **Step 1: Clean state, the worktree's own app**

```bash
git status --short          # expect nothing: the plan and spec were committed before Task 0
pnpm install --frozen-lockfile
pnpm run worktree:down; pnpm run worktree:up
```

- [ ] **Step 2: `pnpm run verify`**

Run: `pnpm run verify 2>&1 | tee $S/final-verify.log`
Expected: exit 0. Record each project's file and test counts from the vitest summaries, with the arithmetic (unit + components, then unit-sweeps + integration), for the PR body.

- [ ] **Step 3: `pnpm run build`**

Run: `pnpm run build 2>&1 | tee $S/final-build.log`
Expected: exit 0, and no `pg-native` / `query_compiler` warning, or each warning carrying its verdict from Task 10.

- [ ] **Step 4: e2e and its duration** (risk 5)

Run: `/usr/bin/time -p pnpm exec playwright test 2>&1 | tee $S/final-e2e.log`
Expected: green. Record `real` beside Task 0's. A slowdown of more than 25 % is reported. It blocks the "stays on in production" verdict, not the matcher work (§9 risk 5).

- [ ] **Step 5: Both images and the three docker-build steps, exactly as ci.yml runs them**

```bash
docker build -t fairyoga .
docker build --target migrate -t fairyoga-migrate .
```
Then paste the `run:` block of each of these ci.yml steps verbatim into `bash -e`: "Prisma client loads in the runner image", "Prisma schema engine loads in the migration image" and "Reserved-slug check loads in the migration image". Expected: all three exit 0 and print their success lines.

- [ ] **Step 6: The after-measurements**

Re-take the image sizes and idle RSS if anything changed since Task 10. Put the before/after table in `$S/measurements.md`, ready for the PR body.

- [ ] **Step 7: Stop the worktree app**

Run: `pnpm run worktree:down`

---

### Task 13: After the push (the orchestrator; one docs commit)

- [ ] **Step 1: amd64 confirmation** (risk 9). On the PR's first CI run, the docker-build job's "Prisma client loads in the runner image" must print its success line on `ubuntu-latest`. A different `type` or `code` blocks the merge: go back to Task 10 Step 3 with the CI output. The same run confirms the factory's `connectionTimeoutMs` case on `ubuntu-latest`; it runs in the ordinary `unit` job.
- [ ] **Step 2: Record it.** Once Step 1 has passed, add one sentence to `docs/supply-chain.md` "Prisma's engine in the images": `ENETUNREACH` is confirmed on amd64 by CI, naming the run. Commit it as `docs: the client probe's errno is confirmed on amd64 (#885)`.
- [ ] **Step 3: The PR body** carries:
  - every measurement in `$S/measurements.md`, each with its command;
  - the red-window note (Tasks 4–8 are not bisectable);
  - the five spec defects above;
  - the D3 per-site verdict table;
  - the per-site ceiling bounds and the 20 s threshold, as plan choices;
  - the D5 reversal of the `2026-09-23-transient-kind` spec's `P2034` call;
  - a dated note that the `#674` spec's stack rationale no longer holds on C+A (D11), without editing that spec;
  - the #888/#901 note, answered (D6);
  - the integration files touched, by path;
  - "**#889 is unaffected**";
  - the counts with their arithmetic: 18 `isUniqueConflictOn` calls on 17 lines, 28 test call lines, 9 `connection_limit` files, 54 `P2024` lines at spec time, and 53 census files;
  - **not measured, by decision**: §6 item 8 (production `availableParallelism()`), §6 item 10, and D4's CI `nproc` / physical core count. The docs state the production pool as derived from the CAX21's published 4 vCPU, with the re-derivation command, and the CI pool size is not recorded.

---

## Self-review

- **Spec coverage.**
  - Decisions: D1 → Tasks 4 and 10. D2 → 1, 6, 8, 9. D3 → 7. D4 → 2, 4, 8. D5 → 3. D6 → 3 and 9. D7 → 10. D8 → 4 and 11. D9 → 2 (lint, tether), 4 (pins), 10 (build, Dockerfile, docs). D10 / §7 → 1, 6, 7, 8, 9. D11 → 5.
  - §6 items: 1 → 4, 9, 12; 2–3 → 4, 10; 4–6 → 10; 7 → 0, 10, 12; 8 and 10 → not measured, by decision (Task 13 Step 3); 9 → 4; 11 → 11; 12 → 5.
  - §7 guard bites: the `pgErrorOf` bites run in 1 and 6, and over the whole matrix in 8. The 23505 source bite is in 7. The isCheck / terminal / exclusion / restrict / mintKey bites are in 6. `P2034` and the pool literal are in 3 and 8. The registry and caller bites, including all the local-net names, are in 7. The serializer bites are in 3 and 9. Factory defaults, empty URL and `poolMax` are in 2 and 4. `lowStackClient`, `isStackDepthError`, paging and the bind limit are in 4 and 5. Tether and lint are in 2. Probe and slug are in 10.
  - §8 → 11. The docs list in D9 → 1, 3, 4, 5, 7, 8, 10.
- **Placeholders.** The `<... by exact path>` markers in `git add` lines stand for the ledger's further rows, which cannot be known before Task 4. Every file known now is spelled out.
- **Type consistency.**
  - Task 1's `PgError`, `pgErrorOf`, `isPgPoolTimeout`, `adapterKindOf`, `AdapterKind` and `PG_POOL_TIMEOUT_MESSAGE` keep those names in Tasks 3 and 5–9, and its `pgPoolTimeout` is used in Tasks 3 and 8.
  - Task 2's `poolConfigFor`, `PrismaClientFactoryOptions` and `DEFAULT_POOL_MAX` are used in Task 4.
  - Task 5 defines `peakBoundParams`, `resetBoundParams` and `BIND_LIMIT_PARENTS`.
  - Task 7 defines `UNIQUE_CONSTRAINTS`, `UniqueConstraintName` and `raceBehindHolder<T>`.
- **Review Focus.** 1 → Task 7 Step 3 (`pg-error-sites.test.ts`); 2 → Task 1 Step 1; 3 → Task 4 Step 2; 4 → Task 11 Step 4; 5 → Task 11 Step 3.
