# Relation-load paging for platform-wide sweeps — Implementation Plan (#674)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the eight platform-wide sweep reads from failing with Postgres
`54001` (stack depth) once their composite-relation parent set passes about
7,500 rows. Take `autoCancelClasses` off its whole-table registration
aggregate.

**Architecture:** One helper, `readInPages`, reads a sweep's snapshot in keyset
pages of `SWEEP_PAGE_SIZE` rows, so no single Prisma relation load builds a
row-value `IN` list longer than one page. `autoCancelClasses` also gets a
teacher-timezone-safe date window and counts active registrations per page
with a single-column `groupBy`. Each paged site is pinned by a ceiling test run
on a Prisma client whose session `max_stack_depth` is lowered, so a few
hundred rows reproduce what takes thousands in production.

**Tech Stack:** Next.js 16, TypeScript strict, Prisma 6.19.3, PostgreSQL 16,
Vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-relation-load-paging-design.md`.
Read it first: it carries the census, the measurements and the rejected
alternatives.

## Global Constraints

- `SWEEP_PAGE_SIZE = 500`, defined once, in `src/lib/read-in-pages.ts`.
- Ceiling tests use `max_stack_depth = '200kB'` and seed `CEILING_ROWS = 1000`
  parent rows. Measured in plain SQL on 2026-09-24: at 200kB, 700 row-value
  tuples parse and 800 fail, for both 2- and 3-column keys. So a 500-row page
  passes and a 1,000-row unpaged load fails. Task 1 re-confirms this through
  Prisma before anything depends on it.
- `SET max_stack_depth` needs a superuser. The local role `yoga` and CI's
  service-container `POSTGRES_USER` both are one.
- TypeScript `strict`, no `any`. Services stay framework-agnostic.
- **Comment Discipline (CLAUDE.md):** a comment annotates only its own code.
  The site roster, counts and the census live in `docs/technical-architecture.md`
  (Task 6), never in a docblock. No "this previously read X" comments.
- Stage exact paths only, never `git add -A` / `git add .`. Commit messages
  end with the `Co-Authored-By` line the session supplies.
- Sweep tests assert through a scoped client (`tests/scoped-sweep.ts`,
  `docs/test-database.md` §2). The new test file joins `SWEEP_TESTS`
  (`vitest.tiers.ts`), so no other sweep runs while its 1,000 rows exist.
- An `afterAll` that deletes by an id assigned in `beforeAll` must guard
  against that id being `undefined`. An undefined Prisma filter deletes every
  row.
- Fast inner loop: `pnpm exec vitest run --project unit-sweeps src/services/sweep-page-ceiling.test.ts`
  and `pnpm exec vitest run --project unit <file>`.
- **Task order is load-bearing:** Task 1 produces the helper and the harness
  that every later task uses. Tasks 2–5 are independent of each other. Task 6
  documents what 2–5 built.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/read-in-pages.ts` (new) | `SWEEP_PAGE_SIZE`, `readInPages` — the paging loop, nothing else |
| `src/lib/read-in-pages.test.ts` (new) | pure unit tests of the loop |
| `tests/stack-ceiling.ts` (new) | `lowStackClient`, `CEILING_ROWS`, `isStackDepthError`, bulk seed helpers |
| `src/services/sweep-page-ceiling.test.ts` (new) | the calibration test and one ceiling test per paged site |
| `vitest.tiers.ts` | add the new test file to `SWEEP_TESTS` |
| `src/services/class-transitions.ts` | `autoCancelClasses` (window + paged + groupBy), `autoTransitionToInProgress`, `autoCompleteClasses` (paged) |
| `src/services/class-transitions.test.ts` | window-edge tests for the new pure window function |
| `src/services/waitlist-reconciliation.ts` | paged candidate read |
| `src/services/class-generator.ts`, `src/services/studio-class-generator.ts` | extract and page the template read |
| `src/services/notifications.ts` | page `getUnreadForEmailFallback` on `(createdAt, id)` |
| `src/services/payment-reminders.ts` | extract and page the due-payment read |
| `docs/technical-architecture.md` | new "Relation loads over platform-wide sets" subsection |

---

### Task 1: `readInPages` and the ceiling harness

**Files:**
- Create: `src/lib/read-in-pages.ts`, `src/lib/read-in-pages.test.ts`, `tests/stack-ceiling.ts`, `src/services/sweep-page-ceiling.test.ts`
- Modify: `vitest.tiers.ts` (append `'src/services/sweep-page-ceiling.test.ts'` to `SWEEP_TESTS`)

**Interfaces — produces:**
```ts
// src/lib/read-in-pages.ts
export const SWEEP_PAGE_SIZE = 500;
export async function readInPages<T>(
  fetchPage: (after: T | undefined, take: number) => Promise<T[]>,
): Promise<T[]>;

// tests/stack-ceiling.ts
export const CEILING_STACK = '200kB';
export const CEILING_ROWS = 1000;
export function lowStackClient(): Promise<PrismaClient>;   // connection_limit=1, session SET applied and verified
export function isStackDepthError(err: unknown): boolean;
export interface SeededTeachers { teacherIds: string[]; teacherRoomIds: string[]; cleanup(): Promise<void> }
export function seedTeachers(db: PrismaClient, count: number, tag: string): Promise<SeededTeachers>;
export function seedClasses(
  db: PrismaClient,
  teachers: SeededTeachers,
  opts: { rows: number; dates: Date[]; status: 'open' | 'in_progress'; minStudents: number; maxStudents: number },
): Promise<{ classIds: string[] }>;
```

- [ ] **Step 1: Write the failing unit tests for `readInPages`.**
  `src/lib/read-in-pages.test.ts` uses a fake `fetchPage` over an in-memory
  sorted array of `{ id: string }`. Its `where` is `id > after.id`, and it
  records every call's `(after, take)`. Cases:
  - An empty source returns `[]` after exactly one call, with `after === undefined`.
  - `SWEEP_PAGE_SIZE - 1` rows take one call.
  - Exactly `SWEEP_PAGE_SIZE` rows take two calls, the second returning `[]`.
  - `2 * SWEEP_PAGE_SIZE + 1` rows take three calls.
  - Every call passes `take === SWEEP_PAGE_SIZE`.
  - Each non-first call's `after` is the previous page's last element, by reference.
  - The concatenated result equals the source in order.
  - A `fetchPage` that returns more than `take` rows makes `readInPages`
    throw. This is a caller bug, since the loop's termination and cursor would
    otherwise be wrong.

- [ ] **Step 2: Run it and see it fail** (module not found).
  `pnpm exec vitest run --project unit src/lib/read-in-pages.test.ts`

- [ ] **Step 3: Implement `src/lib/read-in-pages.ts`.**
  ```ts
  export const SWEEP_PAGE_SIZE = 500;

  export async function readInPages<T>(
    fetchPage: (after: T | undefined, take: number) => Promise<T[]>,
  ): Promise<T[]> {
    const rows: T[] = [];
    let after: T | undefined;
    for (;;) {
      const page = await fetchPage(after, SWEEP_PAGE_SIZE);
      if (page.length > SWEEP_PAGE_SIZE) {
        throw new Error(`readInPages: fetchPage returned ${page.length} rows for take ${SWEEP_PAGE_SIZE}`);
      }
      rows.push(...page);
      if (page.length < SWEEP_PAGE_SIZE) return rows;
      after = page[page.length - 1];
    }
  }
  ```
  The docblock says what the helper is for and why the caller owns the keyset
  and `orderBy`. Link to `docs/technical-architecture.md` ("Relation loads over
  platform-wide sets") for why sweeps page; Task 6 writes that section. Do not
  list call sites.

- [ ] **Step 4: Run the unit tests and see them pass.**

- [ ] **Step 5: Write `tests/stack-ceiling.ts`.**
  - `lowStackClient()`: builds the URL from `process.env.DATABASE_URL` (the
    `unit-sweeps` project sets it to the test DB) and appends
    `connection_limit=1` with `?` or `&`. It creates a
    `new PrismaClient({ datasourceUrl })`, runs
    ``$executeRawUnsafe(`SET max_stack_depth = '${CEILING_STACK}'`)``, reads it
    back with `SHOW max_stack_depth`, and throws if the value differs. That
    catches a pool that handed the SET to a different connection.
  - `isStackDepthError(err)`: true only for Postgres SQLSTATE `54001`. For a
    `$queryRaw` failure the shape is known: a
    `Prisma.PrismaClientKnownRequestError` with `code === 'P2010'` and
    `meta.code === '54001'`, measured 2026-09-24. **The shape for a failed
    `findMany` relation load is not yet known. Step 7 measures it**, and the
    function accepts exactly the observed shape, keyed on the SQLSTATE where
    one is exposed. If the SQLSTATE is not exposed anywhere, fall back to the
    Postgres server text `stack depth limit exceeded`. That is database text,
    not application copy. Record in a one-line comment which shape was seen.
  - `seedTeachers(db, count, tag)` creates `count` accounts, teachers, rooms and
    teacher rooms, following `tests/class-fixtures.ts` and the `beforeAll` of
    `src/services/class-transitions.test.ts`: unique emails and slugs from
    `tag`, and `defaultTimezone: 'UTC'`. `cleanup()` deletes the teachers
    (entries cascade) and then the rooms and accounts. It does nothing when
    the id arrays are empty.
  - `seedClasses(db, teachers, opts)` inserts `opts.rows` pairs of
    `CalendarEntry` + `Class` with two `createMany` calls, not N nested
    creates. Ids are generated client-side with `crypto.randomUUID()`.
    - Entry: `kind: 'regular'`, `classType: 'Ceiling'`, `durationMinutes: 15`,
      `cancelledAt: null`.
    - Class: `calendarEntryId`, `kind: 'regular'`, `entryLive: true`,
      `roomArchived: false`, plus the economics (`roomCost: 0`, `minRate: 0`,
      `targetRate: 0`) and `opts.minStudents`, `opts.maxStudents` and
      `opts.status`.
    - Rows go round-robin across `teachers.teacherIds`. Within one teacher,
      slots are 15-minute steps from 00:00 on each of `opts.dates` in turn.
      That gives `96 × dates.length` slots per teacher, so it never overlaps
      under `CalendarEntry_teacher_slot_excl`. Throw if
      `rows > teachers × 96 × dates.length`.

- [ ] **Step 6: Write the calibration test in `src/services/sweep-page-ceiling.test.ts`.**
  The file header states the harness's purpose in two sentences and links the
  spec. The `describe('ceiling harness')` has two cases:
  - A `$queryRaw` row-value `IN` over `CalendarEntry (id, kind)` built with
    `Prisma.join` returns with `SWEEP_PAGE_SIZE` tuples, and rejects with
    `isStackDepthError` true at `CEILING_ROWS` tuples. This proves the stack
    setting splits the two sizes.
  - A second client from `lowStackClient()` reports `CEILING_STACK`, and the
    default `PrismaClient` does not. This proves the SET is session-scoped and
    cannot leak into the rest of the tier.

- [ ] **Step 7: Measure the `findMany` failure shape.**
  In the same file, a temporary case seeds `CEILING_ROWS` open classes on 11
  teachers (`seedTeachers(db, 11, ...)`; 11 × 96 ≥ 1000 on one date) and runs
  `low.class.findMany({ where: { id: { in: classIds } }, include: { calendarEntry: true } })`.
  Log the caught error's constructor name, `code` and `meta`, then update
  `isStackDepthError` to match. Turn the case into a permanent one: this
  unpaged load rejects with `isStackDepthError`, and the same load restricted
  to the first `SWEEP_PAGE_SIZE` ids resolves. That is the Prisma-path
  confirmation of the global constraint. If the unpaged load does NOT fail at
  200kB, stop and report the measurement. Every later task depends on it.

- [ ] **Step 8: Run the tier file** (`--project unit-sweeps`) and the unit
  file. Both are green.

- [ ] **Step 9: Mutation proof.** Temporarily set `CEILING_STACK = '2MB'`. The
  "unpaged load rejects" case must go red, since nothing fails at 2MB with
  1,000 rows. Record the failure text and restore. `git status` is clean
  apart from the task's own files.

- [ ] **Step 10: Commit** `src/lib/read-in-pages.ts`, `src/lib/read-in-pages.test.ts`,
  `tests/stack-ceiling.ts`, `src/services/sweep-page-ceiling.test.ts`,
  `vitest.tiers.ts` with the message
  `feat(sweeps): readInPages and a lowered-stack ceiling harness (#674)`.

---

### Task 2: `autoCancelClasses` — window, per-page count, paging

**Files:**
- Modify: `src/services/class-transitions.ts` (the `CANCEL_CHECK_HOURS` block and `autoCancelClasses`)
- Test: `src/services/class-transitions.test.ts` (window edges), `src/services/sweep-page-ceiling.test.ts` (ceiling)

**Interfaces:**
- Consumes: `readInPages`, `SWEEP_PAGE_SIZE`; from the harness `lowStackClient`,
  `seedTeachers`, `seedClasses`, `CEILING_ROWS`, `isStackDepthError`; `scopeSweep`.
- Produces:
  ```ts
  export const MAX_CANCEL_CHECK_HOURS: number;           // Math.max(...Object.values(CANCEL_CHECK_HOURS))
  export function cancelCandidateDates(now: Date): { from: Date; to: Date }; // UTC-midnight bounds, both inclusive
  ```

- [ ] **Step 1: Write the ceiling test first (RED).**
  In `sweep-page-ceiling.test.ts`, under `describe('autoCancelClasses')`:
  - Seed 11 teachers.
  - `seedClasses` with `rows: CEILING_ROWS`, `status: 'open'`,
    `minStudents: 0`, `maxStudents: 10`, and `dates: [todayUtcMidnight]`. The
    date is inside any correct window. `minStudents: 0` makes every row a no-op
    for the sweep, because a count of 0 is not below 0.
  - Build `scopeSweep(low, { class: { calendarEntry: { teacherId: { in: teacherIds } } } })`.
  - Assert that `autoCancelClasses(scoped.db, now)` resolves to `0`, and that
    `scoped.rowsRead('Class') >= CEILING_ROWS`, so the zero is not vacuous.
  - Run it. Against the current code it must reject with
    `isStackDepthError`. Record that.

- [ ] **Step 2: Write the window-edge tests (RED: the function does not exist).**
  In `class-transitions.test.ts`, as pure tests with no DB:
  - For `now = 2026-07-20T12:00:00Z`, `cancelCandidateDates(now)` returns
    `from = 2026-07-20` and `to = 2026-07-21`, both at UTC midnight.
    - `from`: 07-20 12:00 − 36 h = 07-19 00:00. A stored date must be strictly
      after that, so the first qualifying midnight is 07-20.
    - `to`: 07-20 12:00 + (4 + 14) h = 07-21 06:00, which floors to 07-21.
  - The window contains the date that `classStartInstant`
    (`src/lib/timezone.ts`) maps back for each of these starts:
    - start = `now + 1 minute` and start = `now + MAX_CANCEL_CHECK_HOURS h`,
    - in each of `Pacific/Kiritimati` (UTC+14) and `Etc/GMT+12` (UTC−12),
    - with `now` varied across 00:30Z, 12:00Z and 23:30Z.

    Compute the local date of each start instant with `Intl.DateTimeFormat`
    in the zone, then assert `from <= localDate <= to`.
  - A table test over every `now` hour in one day (24 values) and both zones
    asserts the same containment. This table is what makes both bounds bite.
    - The lower bound is tight when a UTC−12 class starts just after `now` at
      local 23:xx, around `now` ≈ 11:00Z.
    - The upper bound is tight when a UTC+14 class starts at
      `now + MAX_CANCEL_CHECK_HOURS` just after local midnight, around
      `now` ≈ 06:00Z.

    Both instants are in the table.

  Run them and see them fail.

- [ ] **Step 3: Implement the window.**
  Beside `CANCEL_CHECK_HOURS`:
  ```ts
  export const MAX_CANCEL_CHECK_HOURS = Math.max(...Object.values(CANCEL_CHECK_HOURS));
  const HOUR_MS = 60 * 60 * 1000;
  /** Zone offsets span UTC−12..UTC+14, and a stored `date` is the teacher's
   * local day, so a start instant lies in [date − 14 h, date + 36 h). */
  export function cancelCandidateDates(now: Date): { from: Date; to: Date } {
    const utcMidnight = (t: number) => {
      const d = new Date(t);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    };
    return {
      // The first midnight strictly after now − 36 h: a start after `now`
      // cannot sit on a local date at or before that instant.
      from: utcMidnight(now.getTime() - 36 * HOUR_MS + 24 * HOUR_MS),
      to: utcMidnight(now.getTime() + (MAX_CANCEL_CHECK_HOURS + 14) * HOUR_MS),
    };
  }
  ```
  Both bounds are tight. Moving either one inward by a day must turn an edge
  case red (Step 6). A bound written one day wide would pass every test, so
  its mutation would certify nothing.
  If `CANCEL_CHECK_HOURS`'s `?? 2` fallback in `inCancelWindow` could exceed the
  max, it cannot (2 ≤ 4). Tether it anyway: replace the literal `2` with a named
  default, and assert in a test that it is `<= MAX_CANCEL_CHECK_HOURS`.

- [ ] **Step 4: Rewrite the snapshot read.**
  ```ts
  const { from, to } = cancelCandidateDates(currentTime);
  const openClasses = await readInPages(async (after, take) => {
    const page = await db.class.findMany({
      where: {
        status: 'open',
        calendarEntry: { cancelledAt: null, date: { gte: from, lte: to } },
        ...(after ? { id: { gt: after.id } } : {}),
      },
      orderBy: { id: 'asc' },
      take,
      include: {
        calendarEntry: {
          select: { date: true, startTime: true, teacher: { select: { defaultTimezone: true } } },
        },
      },
    });
    const counts = await db.registration.groupBy({
      by: ['classId'],
      where: {
        classId: { in: page.map((c) => c.id) },
        status: { in: [...ACTIVE_REGISTRATION_STATUSES] },
      },
      _count: { _all: true },
    });
    const active = new Map(counts.map((c) => [c.classId, c._count._all]));
    return page.map((c) => ({ ...c, activeRegistrations: active.get(c.id) ?? 0 }));
  });
  ```
  - The loop's pre-filter reads `cls.activeRegistrations` instead of
    `cls._count.registrations`.
  - Skip the `groupBy` when the page is empty.
  - Rewrite the long pre-filter comment above the read so it describes the
    per-page `groupBy`, keeping its argument: the filter is load-bearing and
    shares its constant with the count under the lock.
  - Add one sentence each on why the read is windowed and why it is paged,
    linking the docs section.
  - Nothing else in the function changes. The locked re-read and the
    authoritative count are untouched.

- [ ] **Step 5: Run everything and see it green.**
  - `src/services/class-transitions.test.ts` passes **without editing any
    existing auto-cancel test**. That file is the behavioural pin that the
    `groupBy` answers the same question as the `_count`, including the class
    whose registrations are all cancelled.
  - The ceiling test and the window tests pass.

- [ ] **Step 6: Mutation proofs.** For each, record the exact failure, restore
  it, and assert `git status` shows only the task's files.
  1. Remove `readInPages` (one unpaged `findMany` without `take`, cursor or
     `groupBy` loop): the ceiling test goes red with a stack-depth failure.
  2. Narrow `from` by one day (`+ 24 * HOUR_MS` → `+ 48 * HOUR_MS`): a
     window-edge case goes red.
  3. Narrow `to` by one day (`MAX_CANCEL_CHECK_HOURS + 14` → `MAX_CANCEL_CHECK_HOURS - 10`):
     a window-edge case goes red.
  3a. Narrow `from` by less than a day (`- 36 * HOUR_MS` → `- 30 * HOUR_MS`),
     which models an offset range assumed to stop at UTC−6. The table must go
     red. If it stays green, the table lacks the UTC−12 late-evening case.
  4. Drop `status: { in: ... }` from the `groupBy`: the existing "all
     registrations cancelled" auto-cancel test goes red. If no existing test
     does, add one and report it.
  5. `SWEEP_PAGE_SIZE = 1000`: the ceiling test goes red.

  Warm up first: run the file once before each mutation is scored.

- [ ] **Step 7: Commit** with the message
  `fix(sweeps): window and page autoCancelClasses, count registrations per page (#674)`.

---

### Task 3: the other class sweeps — `autoTransitionToInProgress`, `autoCompleteClasses`, `reconcileWaitlists`

**Files:**
- Modify: `src/services/class-transitions.ts`, `src/services/waitlist-reconciliation.ts`
- Test: `src/services/sweep-page-ceiling.test.ts`

**Interfaces — consumes:** `readInPages`, and the harness from Task 1.

- [ ] **Step 1: Ceiling tests (RED), one `describe` per sweep.** Each seeds 11
  teachers and `CEILING_ROWS` classes shaped as a no-op, and runs the sweep
  through `scopeSweep(low, { class: { calendarEntry: { teacherId: { in } } } })`.
  Each asserts the return value, plus `rowsRead('Class') >= CEILING_ROWS`.
  - `autoTransitionToInProgress`: `status: 'open'`, `dates: [tomorrowUtc]`,
    teacher zone UTC. `now` is today at 00:00:30Z, so no class has started.
    Every row is inside `date <= now + 24h` and skipped by the pre-filter.
    Expect `0`.
  - `autoCompleteClasses`: `status: 'in_progress'` on `dates: [tomorrowUtc]`,
    so none has ended. Expect `0`. Read `autoCompleteClasses`'s where clause
    first, and adjust only the seed shape if its predicate needs it.
  - `reconcileWaitlists`: `status: 'open'`, `maxStudents: 1`, `minStudents: 0`,
    far-future `dates` (spread over `ceil(1000 / (11 × 96))` dates). Each class
    also gets:
    - one `registered` Registration of seeded student A;
    - one `waiting` WaitlistEntry (`position: 1`) of seeded student B.

    Both are inserted with `createMany`. Every class is full, so none is
    invoked. The scope also covers `waitlistEntry: { class: { calendarEntry: { teacherId: { in } } } }`
    and `registration` with the same shape. Pass a fresh
    `createReconciliationStreaks()` in `opts`, as that file's existing tests
    do. Assert `summary.candidates === CEILING_ROWS` and that nothing was
    invoked.

    Clean up the students and their rows in `afterAll`, with undefined-id
    guards.

  Run each and record its stack-depth rejection against the current code.

- [ ] **Step 2: Page the three reads.**
  - Same shape as Task 2's read, without the window or the count:
    `...(after ? { id: { gt: after.id } } : {})` merged into `where`,
    `orderBy: { id: 'asc' }`, `take`.
  - `reconcileWaitlists` already orders by `id`, and its `id: { in: candidateIds }`
    stays. It is single-column, so it is safe at any size. Only the
    `calendarEntry` load needed paging.
  - Keep every existing comment that still holds. Add one sentence per site
    linking the docs section. No site list.

- [ ] **Step 3: Green run.** The ceiling tests pass, and
  `src/services/class-transitions.test.ts` and
  `src/services/waitlist-reconciliation.test.ts` pass unedited.

- [ ] **Step 4: Mutation proofs.** Revert each site's paging, one at a time;
  its own ceiling test goes red with a stack-depth failure. Record, restore,
  and check `git status` is clean.

- [ ] **Step 5: Commit** with the message
  `fix(sweeps): page the start, complete and waitlist-reconciliation reads (#674)`.

---

### Task 4: the two generators

**Files:**
- Modify: `src/services/class-generator.ts`, `src/services/studio-class-generator.ts`
- Test: `src/services/sweep-page-ceiling.test.ts`

**Interfaces — produces:**
```ts
// class-generator.ts
export function readGenerationCandidates(db: PrismaClient, teacherId?: string):
  Promise<Array<{ id: string; scheduleRule: { teacherId: string } }>>;
// studio-class-generator.ts
export function readStudioGenerationCandidates(db: PrismaClient):
  Promise<Array<{ id: string; scheduleRule: { teacherId: string } }>>;
```
The loop uses only `template.id` and `template.scheduleRule.teacherId`, for
logging, and re-reads everything else under `claim*ForGeneration`. Confirm
that by reading the loop before narrowing the select. Extracting the read is
what lets a test exercise it without generating classes for 1,000 templates.

- [ ] **Step 1: Ceiling tests (RED).**
  - Seed 2 teachers.
  - Insert `CEILING_ROWS` `ScheduleRule` + `ClassTemplate` pairs with
    `createMany`, 500 per teacher. `dayOfWeek = i % 7`,
    `startTime = 15-minute step floor(i / 7)`, `durationMinutes: 15`. That is
    at most 72 steps per day, well inside the 96 available, so nothing
    overlaps under `ScheduleRule_teacher_slot_excl`.
    - `kind: 'regular'`, `isActive: true`, `isArchived: false`.
    - Templates set `ruleLive: true`, `roomArchived: false`, the seeded
      `teacherRoomId`, and zero economics with `minStudents: 0`,
      `maxStudents: 10`.
  - Call `readGenerationCandidates(low)` directly. It must not be a scoped
    client. It is a pure read, so extra rows only make the set bigger, and
    that cannot turn a RED green. Assert that the result contains every seeded
    template id.
  - The studio twin does the same with `kind: 'studio'` rules and
    `StudioClassTemplate` rows (`location`, `hourlyRate: 0`).

  Against the current code, first extract the function **unchanged** (no
  paging), and see RED on both.

- [ ] **Step 2: Page both reads.**
  - Use `id > after.id`, `orderBy: { id: 'asc' }`, `take`.
  - Narrow the select to what the loop reads:
    `select: { id: true, scheduleRule: { select: { teacherId: true } } }`.
    That drops the teacher-timezone hop, which the loop never used.
  - The generator functions call the extracted read.
  - The existing generator comment blocks above the read stay with the read.
    Move them into the extracted function; do not duplicate them.

- [ ] **Step 3: Green run.** The ceiling tests pass, and
  `src/services/class-generator.test.ts` and
  `src/services/studio-class-generator.test.ts` pass unedited, along with any
  other test file that calls `generateClassInstances` /
  `generateStudioClassInstances`. Find those with
  `grep -rln "generateClassInstances\|generateStudioClassInstances" src tests`.

- [ ] **Step 4: Mutation proofs.** Revert each read's paging; its ceiling test
  goes red. Record, restore, and check `git status`.

- [ ] **Step 5: Commit** with the message
  `fix(generators): page the template read (#674)`.

---

### Task 5: email fallback and payment reminders

**Files:**
- Modify: `src/services/notifications.ts` (`getUnreadForEmailFallback`), `src/services/payment-reminders.ts`
- Test: `src/services/sweep-page-ceiling.test.ts`

**Interfaces — produces:**
```ts
// payment-reminders.ts
export function readDuePayments(db: PrismaClient, now: Date): Promise<DuePayment[]>;
// DuePayment = the exact element type sendPaymentReminders' loop reads today
```

- [ ] **Step 1: Ceiling tests (RED).**
  - `getUnreadForEmailFallback`:
    - Seed 11 teachers and `CEILING_ROWS` open classes (any dates).
    - Create one `Notification` per class with `createMany`:
      `recipientType: 'student'`, `recipientId` a seeded student's id,
      `type` a non-immediate type, `relatedClassId` the class,
      `isRead: false`, `emailSent: false`.
    - Call it directly on `low`. It is a read with no side effects.
    - Assert it resolves.
    - Assert its output is sorted by `createdAt` ascending, ties by `id`. The
      order is part of its contract ("oldest first").
  - `readDuePayments`:
    - Seed `CEILING_ROWS` open classes, one student, one `registered`
      Registration per class, and one `Payment` per registration
      (`status: 'overdue'`, `reminderSentAt: null`, `amount: 1`).
    - Call `readDuePayments(low, now)` and assert it contains every seeded
      payment id.
  - Extract `readDuePayments` unchanged first, then see RED on both.

- [ ] **Step 2: Page both reads.**
  - `getUnreadForEmailFallback`:
    - Keyset on `(createdAt, id)`: the page `where` ANDs the existing
      predicate with
      `after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}`.
    - Order with `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]`.
    - The eligibility filter runs over the concatenated rows, as today.
  - `readDuePayments`: use `id > after.id`, `orderBy: { id: 'asc' }`, `take`.
    `sendPaymentReminders` calls it.

- [ ] **Step 3: Green run.** The ceiling tests pass, and
  `src/services/email-fallback.test.ts`,
  `src/services/email-fallback.consent.test.ts`,
  `src/services/notifications.test.ts` and
  `src/services/payment-reminders.test.ts` pass unedited.

- [ ] **Step 4: Mutation proofs.**
  1. Revert each paging: its ceiling test goes red.
  2. For the email fallback, also replace the tie-break with `createdAt`
     alone, cursor `createdAt > after.createdAt`. Then seed 2 ×
     `SWEEP_PAGE_SIZE` notifications sharing one `createdAt`: the sort/coverage
     assertion must go red, because rows are lost at the page boundary. If the
     existing ceiling test cannot see this, add that case. It is the realistic
     way a hand-rolled cursor breaks.

  Record, restore, and check `git status`.

- [ ] **Step 5: Commit** with the message
  `fix(sweeps): page the email-fallback and payment-reminder reads (#674)`.

---

### Task 6: the rule, in `docs/`

**Files:**
- Modify: `docs/technical-architecture.md` (new `### Relation loads over platform-wide sets` under The Services Layer, after "Error responses")

- [ ] **Step 1: Write the section.** Contents:
  - The mechanism: a composite-relation load is a row-value `IN`, and Postgres
    fails with `54001` at about 7,500 tuples on the default 2 MB stack. A
    single-column `IN` is flat and safe, and relation filters compile to joins.
  - The rule: a sweep whose parent set grows with the whole platform reads
    through `readInPages`.
  - How the ceiling tests reproduce it (`tests/stack-ceiling.ts`).
  - The per-tenant verdict and its arithmetic: 6 classes a week reaches
    7,500 entries after about 24 years.
  - The re-derivation commands from the spec's census, verbatim.

  The site list is a table with the command above it. No count in prose.

- [ ] **Step 2: Sweep the branch for stale claims.**
  - Grep the diff's touched functions for `_count`, `every open class`,
    `4 weeks` and "all open", and read each touched docblock whole. A grep
    finds stale names, not stale descriptions.
  - Confirm that every link to the new section resolves to its heading text.

- [ ] **Step 3: Commit** with the message
  `docs(arch): relation loads over platform-wide sets (#674)`.

---

## After the tasks (controller, not a subagent)

1. **Whole-branch review** (6 tasks). One fix wave, one scoped re-review.
2. **Measurement (spec §4).** In `fairyoga-db-1`, create a throwaway database
   `bench_674`. Apply every migration with
   `DATABASE_URL=…/bench_674 pnpm exec prisma migrate deploy`. Load it with
   `psql -v T=500 -v Y=3 -v RD=1100 -f scratchpad/load.sql`. Then time
   `autoCancelClasses`, `reconcileWaitlists` and `generateClassInstances`'s
   read, three runs each, on `origin/main` and on the branch, from a small
   tsx script in the scratchpad. Report the medians with the command. Drop
   `bench_674` afterwards. Never point `load.sql` at the dev or test DB.
3. `pnpm run verify` green, then push, open the PR, and run
   `/pr-review-toolkit:review-pr`.
