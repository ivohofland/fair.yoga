# Validation Loop Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the CI critical path from 6m54 to roughly 3 minutes, and cut
`npm run verify` by a comparable share, by parallelizing the two vitest tiers
that share nothing and splitting the `test` job along its real dependency graph.

**Architecture:** `fileParallelism` moves off the vitest config root onto the
individual projects, because its justification (`docs/test-database.md` §2) is
about shared database state and only two of the three projects have one. Three
test files that mutate rows they do not own are scoped to their own fixtures
first; the one file whose sweeps have no scope parameter (`class-transitions`)
moves into a `unit-sweeps` project run as a **separate `vitest run`
invocation**, because a sibling project carrying `fileParallelism: false` was
measured not to isolate. The CI `test` job then splits three ways, with a
step-less `test` job doing `needs: [...]` so the branch ruleset's required
context keeps reporting.

**Tech Stack:** vitest 4 (projects: `unit`, `unit-sweeps`, `components`,
`integration`), Playwright, Prisma + PostgreSQL 16, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-24-ci-validation-loop-design.md`

**Issue:** #321

## Global Constraints

- **Do not change production code.** Every fix here is in test files, vitest
  config, `package.json` scripts, CI YAML, and docs. If a task appears to
  require a production signature change, stop — the spec rejected that trade
  (Rejected, first bullet) and the task has been misread.
- **`integration` stays serial.** #290 rests on it. `fileParallelism: false`
  on that project is load-bearing, not vestigial.
- **`playwright.config.ts` is not touched.** `workers: 1` stays (spec D5).
- **Applied migrations are immutable** (CLAUDE.md). Nothing here touches
  `prisma/migrations/`.
- **Green twice is not green.** The spec's D3 defect passed two consecutive
  runs. Any "verify it passes" step that concerns parallelism runs **five**
  times, and the criterion is five of five.
- Required status check contexts on `main` are exactly `checks` and `test`
  (ruleset `19724469`). No task edits the ruleset.

---

### Task 1: Scope `class-generator.test.ts` to its own teacher

**Files:**
- Modify: `src/services/class-generator.test.ts` (lines 96-111, 179-185, and 8 call sites)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a `class-generator.test.ts` that mutates only rows belonging to
  the teacher created in its own `beforeAll`. Task 3 relies on this file being
  safe in the parallel `unit` pool.

Background: `generateClassInstances` is declared
`(db: PrismaClient, from?: Date, teacherId?: string)` at
`src/services/class-generator.ts:648-652`. The test never passes the third
argument, so every call sweeps every template in the database. The file
compensates with a global "deactivate all active templates, restore them
afterwards" dance — which is itself the worst parallelism hazard in the tier.
Passing the teacher id removes the reason for that dance, so both changes land
together.

- [ ] **Step 1: Confirm the failure**

Run:
```bash
npx vitest run --project unit --fileParallelism \
  src/services/class-generator.test.ts src/services/slot-constraints.test.ts
```

Expected: FAIL. Two distinct symptoms, both of which must appear —
`class-generator.test.ts` asserting `expected 4, received 8` (its own count
inflated by the neighbouring file's templates), and `slot-constraints.test.ts`
failing at file level with
`Foreign key constraint violated on the constraint: Class_teacherRoomId_fkey`
in its `afterAll` (its `teacherRoom` rows still referenced by `Class` rows the
unscoped sweep created between its two deletes).

If `slot-constraints` does NOT fail here, do not treat that as good news —
re-run the command up to five times. It is a race, and the spec's whole D3
finding is that this suite reports green intermittently.

- [ ] **Step 2: Pass the teacher id at the six `from`-bearing call sites**

Lines 193, 225, 244, 271, 289, 308 each read:

```ts
    const count = await generateClassInstances(prisma, from);
```

Change every one to:

```ts
    const count = await generateClassInstances(prisma, from, teacherId);
```

`teacherId` is declared at line 92 and assigned at line 123 in the enclosing
`describe('generateClassInstances (DB)')`, so it is in scope at all six.

- [ ] **Step 3: Pass the teacher id at the two mid-sweep call sites**

Lines 865 and 936 each read:

```ts
      const sweeping = generateClassInstances(prisma).then((n) => {
```

These pass no `from`, so the second argument becomes explicit `undefined`:

```ts
      const sweeping = generateClassInstances(prisma, undefined, teacherId).then((n) => {
```

Both sit in nested describes (`— archive mid-sweep` at line 820, `— edit
mid-sweep` at line 885) inside the same outer describe, so `teacherId` is in
scope.

- [ ] **Step 4: Delete the global deactivation from `beforeAll`**

Remove the declaration at lines 96-97:

```ts
  /** IDs of other active templates deactivated during setup, restored in teardown. */
  let deactivatedTemplateIds: string[] = [];
```

and the block that opens `beforeAll` (lines 100-111):

```ts
    // Deactivate any pre-existing active templates so they don't interfere
    const existingActive = await prisma.classTemplate.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    deactivatedTemplateIds = existingActive.map((t) => t.id);
    if (deactivatedTemplateIds.length > 0) {
      await prisma.classTemplate.updateMany({
        where: { id: { in: deactivatedTemplateIds } },
        data: { isActive: false },
      });
    }
```

`beforeAll` now opens directly with `const teacher = await prisma.teacher.create({`.

- [ ] **Step 5: Delete the matching restore from `afterAll`**

Remove lines 179-185:

```ts
    // Restore previously active templates
    if (deactivatedTemplateIds.length > 0) {
      await prisma.classTemplate.updateMany({
        where: { id: { in: deactivatedTemplateIds } },
        data: { isActive: true },
      });
    }
```

`afterAll` now runs its five scoped deletes and then `await prisma.$disconnect();`.

- [ ] **Step 6: Verify both files pass in parallel, five times**

Run:
```bash
for i in 1 2 3 4 5; do
  npx vitest run --project unit --fileParallelism \
    src/services/class-generator.test.ts src/services/slot-constraints.test.ts \
    --reporter=dot 2>/dev/null | grep "Test Files"
done
```

Expected: five lines, each `Test Files  2 passed (2)`.

If `slot-constraints.test.ts` still fails, it is a genuine second bug and gets
its own diagnosis — do NOT move it into `unit-sweeps` to make this green. The
spec's acceptance criterion 1 says so explicitly.

- [ ] **Step 7: Verify no regression when run alone**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS, same test count as before the change. The deleted dance was
protecting against the unscoped sweep, so removing it must change nothing now
that the sweep is scoped.

- [ ] **Step 8: Commit**

```bash
git add src/services/class-generator.test.ts
git commit -m "test: scope the generator sweep to its own teacher (#321)

generateClassInstances takes (db, from?, teacherId?) and this file passed
two arguments in eight places, so every call swept every template in the
database. It compensated with a beforeAll that deactivated EVERY active
template and an afterAll that restored them — a global mutation of other
files' fixtures, and the reason slot-constraints.test.ts died in teardown
on Class_teacherRoomId_fkey under file parallelism.

Passing the teacher id removes the reason for the dance, so both go."
```

---

### Task 2: Scope `magic-link.test.ts`'s table wipe

**Files:**
- Modify: `src/lib/auth/magic-link.test.ts:19-21`

**Interfaces:**
- Consumes: nothing.
- Produces: a `magic-link.test.ts` whose cleanup touches only its own rows.
  Task 3 relies on this.

Background: the file truncates `magicLinkToken` after every test with no
`where` clause. `src/services/auth-cleanup.test.ts` is the only other unit file
touching that table, and at lines 76-79 it asserts a specific token **survives**
its sweep. In one parallel pool those collide.

**This one has no reproducible red.** It did not fail in any of the four probe
runs recorded in the spec; it was found by grepping the tier. Step 1 attempts
to provoke it and Step 2 tells you what to do either way — do not skip the fix
because the loop stayed green, and do not spend more than one loop trying.

- [ ] **Step 1: Attempt to provoke the collision**

Run:
```bash
for i in $(seq 1 10); do
  npx vitest run --project unit --fileParallelism \
    src/lib/auth/magic-link.test.ts src/services/auth-cleanup.test.ts \
    --reporter=dot 2>/dev/null | grep "Test Files"
done
```

Expected: most or all runs green. A failure in `auth-cleanup.test.ts` on
`expect(...findUnique({ where: { tokenHash: liveTokenHash } })).not.toBeNull()`
is the collision landing; record it in the commit message if you see it.

- [ ] **Step 2: Scope the cleanup**

Lines 19-21 currently read:

```ts
afterEach(async () => {
  await db.magicLinkToken.deleteMany();
});
```

Replace with:

```ts
afterEach(async () => {
  // Scoped, not a truncate: `auth-cleanup.test.ts` is the other unit suite
  // holding `magicLinkToken` rows, and it asserts one SURVIVES its sweep.
  // Every address this file mints is `*@example.com`; that file's are
  // `cleanup-${uniqueSuffix}@test.local`, so the two never overlap.
  await db.magicLinkToken.deleteMany({ where: { email: { endsWith: '@example.com' } } });
});
```

- [ ] **Step 3: Verify both files pass in parallel, five times**

Run:
```bash
for i in 1 2 3 4 5; do
  npx vitest run --project unit --fileParallelism \
    src/lib/auth/magic-link.test.ts src/services/auth-cleanup.test.ts \
    --reporter=dot 2>/dev/null | grep "Test Files"
done
```

Expected: five lines, each `Test Files  2 passed (2)`.

- [ ] **Step 4: Re-run the scan that found it**

Run:
```bash
grep -rn "deleteMany()\|deleteMany({})\|updateMany({ where: { isActive" \
  src --include="*.test.ts"
```

Expected: no output. Any hit is another file with the same hazard and needs the
same treatment before Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/magic-link.test.ts
git commit -m "test: scope the magic-link cleanup to its own addresses (#321)

afterEach truncated magicLinkToken with no where clause. auth-cleanup.test.ts
is the only other unit suite holding rows in that table and asserts one
survives its sweep, so the two collide in a parallel pool.

Found by grepping the tier, not by a red run — which is the point: four
probe runs of the parallel config never surfaced it."
```

---

### Task 3: Per-project `fileParallelism`, the `unit-sweeps` project, and a two-pass `npm test`

**Files:**
- Modify: `vitest.config.ts` (root `test` block and all three projects)
- Modify: `package.json` (`test` and `test:coverage` scripts)

**Interfaces:**
- Consumes: Tasks 1 and 2 — the `unit` pool is only safe to parallelize once
  both have landed.
- Produces: project names `unit`, `unit-sweeps`, `components`, `integration`.
  Task 4's CI jobs invoke exactly these names.

- [ ] **Step 1: Confirm the whole tier fails in one parallel invocation**

Run: `npx vitest run --project unit --fileParallelism --reporter=dot`
Expected: FAIL — `class-transitions.test.ts` reports 2 failed tests
(`does not complete a class rescheduled after the sweep read it` and
`re-reads under the lock, so a reschedule landing while it waits is seen`).
Its sweeps `autoTransitionToInProgress`, `autoCancelClasses` and
`autoCompleteClasses` are each `(db, now?)` with no scope to pass — this is the
file the spec quarantines, and this red is what justifies it.

- [ ] **Step 2: Remove `fileParallelism` from the config root**

In `vitest.config.ts`, delete the root-level `fileParallelism: false` line.
Replace the comment that justified it with one pointing at where the setting
now lives:

```ts
      // `fileParallelism` is per-project below, NOT here. Its reason
      // (docs/test-database.md §2) is shared *database* state, which
      // `components` does not have — it inherited 44s/run of serialization
      // from this line for a constraint that was never about it (#321).
```

- [ ] **Step 3: Split the `unit` project and add `unit-sweeps`**

Replace the `unit` project entry with these two:

```ts
        {
          extends: true,
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts'],
            // class-transitions is the one file whose service calls have no
            // teacher scope to pass — see `unit-sweeps` below.
            exclude: ['**/node_modules/**', 'src/services/class-transitions.test.ts'],
            fileParallelism: true,
            env: { DATABASE_URL: testUrl },
            globalSetup: ['./tests/setup/unit-db.ts'],
          },
        },
        {
          extends: true,
          test: {
            name: 'unit-sweeps',
            // `autoTransitionToInProgress`, `autoCancelClasses` and
            // `autoCompleteClasses` are each `(db, now?)` — whole-database by
            // construction, so this file cannot share a database with a
            // concurrent one.
            //
            // It MUST run in a separate `vitest run` invocation from `unit`,
            // not merely a separate project: per-project
            // `fileParallelism: false` serializes files *within* a project and
            // does NOT stop sibling projects running alongside. Measured
            // 2026-08-24 — that arrangement was green twice and red twice in
            // four runs (#321, spec D3). `package.json`'s `test` script is
            // what keeps the two invocations apart.
            include: ['src/services/class-transitions.test.ts'],
            fileParallelism: false,
            env: { DATABASE_URL: testUrl },
            globalSetup: ['./tests/setup/unit-db.ts'],
          },
        },
```

- [ ] **Step 4: Set `fileParallelism` on the other two projects**

Add `fileParallelism: true,` to the `components` project (it is jsdom-only and
touches no database — the existing comment beside it already says so).

Add to the `integration` project:

```ts
            // Serial, and load-bearing: this tier drives the one app on :3000
            // over HTTP. #290 measured four parallel runs producing four
            // different victims. Do not flip this to match its siblings.
            fileParallelism: false,
```

- [ ] **Step 5: Verify the two passes are green in isolation**

Run:
```bash
npx vitest run --project unit --project components --reporter=dot
npx vitest run --project unit-sweeps --project integration --reporter=dot
```

Expected: pass 1 `Test Files  112 passed (112)` (67 unit + 45 components),
pass 2 `Test Files  34 passed (34)` (1 sweeps + 33 integration).

Pass 2 runs its two projects concurrently, which is safe only because they
connect to different databases — `unit-sweeps` inherits the `DATABASE_URL`
override to `DATABASE_URL_TEST`, `integration` uses `DATABASE_URL` (the
database the app on :3000 reads). If that override is ever removed these must
become separate invocations too.

- [ ] **Step 6: Rewrite the `test` and `test:coverage` scripts**

In `package.json`:

```json
    "test": "vitest run --project unit --project components && vitest run --project unit-sweeps --project integration",
    "test:coverage": "vitest run --coverage --no-file-parallelism",
```

`test:coverage` keeps today's fully-serial behaviour on purpose: a coverage run
collects all four projects in one invocation, which would reintroduce exactly
the overlap D3 measured. It is not on any hot path.

- [ ] **Step 7: Verify `--no-file-parallelism` actually overrides the per-project settings**

Run: `npx vitest run --coverage --no-file-parallelism --reporter=dot`
Expected: PASS, and a wall-clock in the same range as the old fully-serial run
(~270s locally) rather than the new parallel one. If it comes back fast, the
CLI flag is not overriding per-project config and `test:coverage` must instead
be spelled as the same two-pass `&&` chain as `test`, with coverage merged or
accepted per-pass.

- [ ] **Step 8: Verify `npm test` five consecutive times**

Run:
```bash
for i in 1 2 3 4 5; do npm test 2>&1 | grep -E "Test Files"; done
```

Expected: five iterations, each printing two `Test Files ... passed` lines with
no `failed`. Five, not three — the defect this design avoids survived two.

- [ ] **Step 9: Verify no test was lost**

Run: `npm test 2>&1 | grep -E "^ +Tests +"`

Expected, exactly:

| pass | project | files | tests |
|---|---|---|---|
| 1 | `unit` | 67 | **1052** |
| 1 | `components` | 45 | **296** |
| 2 | `unit-sweeps` | 1 | **16** |
| 2 | `integration` | 33 | **513** |

`grep` prints one `Tests` line per invocation, so you will see two numbers:
**1348** for pass 1 (1052 + 296) and **529** for pass 2 (16 + 513). They sum to
1877, which is the pre-change total — 1068 unit + 296 components + 513
integration, with the unit tier's 1068 now split 1052/16 by moving
`class-transitions.test.ts` (16 tests) into `unit-sweeps`.

If the total is anything but 1877, a glob is wrong — most likely `unit`'s
`exclude` swallowing more than the one file, or its `include` and
`unit-sweeps`'s overlapping so a file runs twice.

- [ ] **Step 10: Record the new timing**

Run: `/usr/bin/time -p npm test 2>&1 | tail -3`
Note the `real` figure. The spec projects ~125s locally against a measured
~272s before. Write the actual number into the commit message.

- [ ] **Step 11: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "perf: parallelize the two vitest tiers that share nothing (#321)

fileParallelism moves off the config root onto the projects. components is
jsdom-only and had been inheriting a serialization whose reason
(docs/test-database.md §2) is shared database state: 55.8s serial, 11.6s
parallel, 45/45 green either way.

class-transitions.test.ts moves to a unit-sweeps project run as a SEPARATE
invocation. A sibling project carrying fileParallelism: false does not
isolate — measured green, green, 1 failed, 2 failed across four runs.

integration keeps fileParallelism: false; #290 rests on it."
```

---

### Task 4: Split the CI `test` job behind a fan-in gate

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: project names from Task 3 (`unit`, `unit-sweeps`, `components`,
  `integration`).
- Produces: jobs `checks`, `test-components`, `test-unit`,
  `test-integration-e2e`, `test`. The last two names are load-bearing — `test`
  is a required status check context.

- [ ] **Step 1: Add the `test-components` job**

It needs no database and no build. Insert after the `checks` job:

```yaml
  # No database, no build: the components project is jsdom only
  # (vitest.config.ts). This job exists because it used to queue behind 20s of
  # container init and a 27s build it never touched.
  test-components:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      # Nothing connects here. The value exists so that a transitive
      # PrismaClient construction at import time resolves env("DATABASE_URL")
      # rather than throwing — same reason the `checks` job sets it.
      DATABASE_URL: postgresql://ci:ci@localhost:5432/ci
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies # postinstall runs prisma generate
        run: npm ci

      - name: Component tests
        run: npx vitest run --project components
```

- [ ] **Step 2: Add the `test-unit` job**

Copy the existing `test` job's `services: postgres` block and its entire `env:`
block verbatim, then give it these steps. It keeps the database and drops the
build:

```yaml
  test-unit:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_DB: ethical_yoga
          POSTGRES_USER: yoga
          POSTGRES_PASSWORD: test_password
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      # Copied verbatim from the pre-split `test` job — see that history for
      # why DATABASE_URL_TEST must be set explicitly here.
      DATABASE_URL: postgresql://yoga:test_password@localhost:5432/ethical_yoga
      DATABASE_URL_TEST: postgresql://yoga:test_password@localhost:5432/ethical_yoga_test
      PASSKEY_RP_ID: localhost
      PASSKEY_RP_NAME: fair.yoga
      CRON_SECRET: ci-cron-secret
      CRON_SCHEDULER: 'off'
      RESEND_API_KEY: re_test
      EMAIL_DRY_RUN: '1'
      EMAIL_FROM: noreply@test.local
      NEXT_PUBLIC_APP_URL: http://localhost:3000
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: '22'
          cache: 'npm'

      - name: Install dependencies # postinstall runs prisma generate
        run: npm ci

      - name: Run migrations
        run: npx prisma migrate deploy

      # Fails when schema.prisma and the migration history disagree —
      # catches migrations amended after being applied, and schema edits
      # committed without a migration. Lives here because it needs a live
      # database and this is the cheapest job that has one.
      - name: Check schema/migration drift
        run: npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code

      - name: Unit tests
        run: npx vitest run --project unit

      # A SEPARATE invocation, deliberately: per-project
      # `fileParallelism: false` does not stop sibling projects running
      # alongside, and these two share a database (#321, spec D3).
      - name: Whole-database sweep tests
        run: npx vitest run --project unit-sweeps
```

- [ ] **Step 3: Rename the existing `test` job to `test-integration-e2e`**

Keep its `services`, `env`, and every step from `Run migrations` onward, with
two edits: drop the `Check schema/migration drift` step (it moved to
`test-unit` in Step 2), and change the `Run tests` step to run only the
integration project:

```yaml
      - name: Integration tests
        run: npx vitest run --project integration
```

Everything else in that job — the Next build cache, `Build`, `Start app`, the
Playwright steps, and both `if: failure()` artifact uploads — stays exactly as
it is.

- [ ] **Step 4: Add the fan-in `test` job**

```yaml
  # Steps intentionally absent. This job exists so the branch ruleset's
  # required status check named `test` keeps reporting after the split:
  # ruleset 19724469 requires the contexts `checks` and `test`, and a
  # required check that never runs leaves the pull request pending with no
  # way to merge (same argument as this file's header).
  #
  # No `if: always()`. `needs` fails this job when any dependency fails, and
  # `always()` would let it report success over a red one.
  test:
    runs-on: ubuntu-latest
    needs: [test-components, test-unit, test-integration-e2e]
    steps:
      - name: All test jobs passed
        run: echo "test-components, test-unit and test-integration-e2e all succeeded"
```

- [ ] **Step 5: Validate the workflow parses**

Run: `npx --yes yaml-lint .github/workflows/ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK`.

- [ ] **Step 6: Confirm the job names**

Run: `python3 -c "import yaml; print(sorted(yaml.safe_load(open('.github/workflows/ci.yml'))['jobs']))"`
Expected: `['checks', 'test', 'test-components', 'test-integration-e2e', 'test-unit']`

Both `checks` and `test` must be present and spelled exactly — they are the
required contexts.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: split the test job along its real dependency graph (#321)

components needs neither Postgres nor the build; unit needs Postgres but
not the build. Both queued behind 20s of container init and a 27s build
they never used, making the critical path sum() instead of max().

The step-less \`test\` job is not decoration: ruleset 19724469 requires the
contexts \`checks\` and \`test\`, and a required check that never runs
leaves a PR pending forever. It fans in via needs, with no if: always()."
```

---

### Task 5: Correct the two documents the change falsifies

**Files:**
- Modify: `docs/test-database.md` (§2 non-goals)

**Interfaces:**
- Consumes: Tasks 3 and 4 (the config and CI are their final shape).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Find the stale claim**

Run: `grep -n "fileParallelism" docs/test-database.md`
Expected: a hit in §2 reading
"`fileParallelism: false` already serializes suites" as the reason for
declining per-file database isolation. That sentence no longer describes the
config.

- [ ] **Step 2: Replace it**

Amend that non-goal to say what is now true and record D3's finding where the
next person to attempt this will look:

```markdown
- Per-test-file database isolation or transactional rollbacks (heavier
  machinery than this codebase needs). Since #321 `fileParallelism` is
  per-project, not global: `unit` and `components` run their files in
  parallel, `integration` and `unit-sweeps` do not. What keeps the parallel
  `unit` pool honest is that each file mutates only rows it owns — the three
  files that did not were fixed in #321, and an unscoped
  `deleteMany`/`updateMany` in that pool is a bug.

  A file whose service calls sweep the whole database (no `teacherId`
  parameter to pass) belongs in `unit-sweeps`, which runs as its own
  `vitest run` invocation. It must be a separate invocation and not merely a
  project carrying `fileParallelism: false`: that setting serializes files
  *within* a project and does not stop sibling projects running alongside.
  Measured 2026-08-24 across four runs of exactly that arrangement — green,
  green, one failure, two failures.
```

- [ ] **Step 3: Check nothing else asserts the old behaviour**

Run: `grep -rn "fileParallelism" docs/ src/ .github/ --include="*.md" --include="*.ts" --include="*.yml"`
Expected: hits only in `vitest.config.ts` (the four project settings and the
root comment), `docs/test-database.md` (Step 2's text),
`docs/superpowers/specs/2026-08-24-ci-validation-loop-design.md`, and this
plan. Any other prose claiming the suite is globally serial is now false and
must be corrected in this task.

Note: `docs/superpowers/specs/2026-08-21-local-gate-reliability-design.md`
contains the sentence "`vitest.config.ts` sets `fileParallelism: false`, so
integration tests never contend with each other". That remains TRUE — the
`integration` project keeps the setting. Do not edit that spec.

- [ ] **Step 4: Commit**

```bash
git add docs/test-database.md
git commit -m "docs: fileParallelism is per-project now (#321)

§2 declined per-file database isolation because 'fileParallelism: false
already serializes suites'. It no longer does, so the paragraph records
what actually holds the parallel pool together, and D3's four-run
measurement lands where the next person to try a sibling serial project
will look for it."
```

---

### Task 6: Verify the whole gate on a real pull request

**Files:** none — this task only observes.

**Interfaces:**
- Consumes: Tasks 1-5, all committed.
- Produces: the measured CI figure that replaces the spec's projection.

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin spec/ci-validation-loop
gh pr create --title "Split the validation loop: parallel where nothing is shared (#321)" \
  --body "Closes #321. Spec: docs/superpowers/specs/2026-08-24-ci-validation-loop-design.md"
```

- [ ] **Step 2: Confirm the required contexts still report**

Run: `gh pr checks --watch`
Expected: `checks` and `test` both appear and both pass, alongside the three
new job names. If `test` is missing or stuck pending, Step 4 of Task 4 is
wrong and the PR cannot merge — fix before anything else.

- [ ] **Step 3: Measure the new critical path**

```bash
RUN=$(gh run list --workflow=ci.yml --branch spec/ci-validation-loop --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN" --json jobs --jq '.jobs[] | "\(.name) \((((.completedAt|fromdate)-(.startedAt|fromdate)))|floor)s"'
```

Expected: the longest job is `test-integration-e2e`. Record every job's
duration — the critical path is the largest, not the sum.

- [ ] **Step 4: Replace the spec's projections with the measurement**

Edit `docs/superpowers/specs/2026-08-24-ci-validation-loop-design.md`, D3's
closing line — "Projection, local: ~272s → ~125s. Projection, CI: 233s → ~90s.
Both to be replaced with measurements at acceptance." — substituting the real
figures from Step 3 and Task 3 Step 10. State them as measured, and if either
missed its projection say so plainly rather than quietly adjusting the target.

- [ ] **Step 5: Commit and push the measurement**

```bash
git add docs/superpowers/specs/2026-08-24-ci-validation-loop-design.md
git commit -m "docs: replace the CI projections with what actually happened (#321)"
git push
```
