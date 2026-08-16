# Ordered multi-row `Class` locking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five hand-rolled multi-row `Class` lock sites with one tested
helper, so the ordering rule is enforced by code rather than tracked in prose.

**Architecture:** `lockClassRowsOrdered` in `src/lib/db-locks.ts` takes composed
`Prisma.Sql` fragments and owns the 2s bound, `FOR UPDATE OF c`, `ORDER BY c.id`,
the returned ids and dedupe. Four existing `FOR UPDATE OF c` statements adopt it;
`deleteTeacherAccount` gains an ordered pre-lock it never had. The ordering is
pinned once by a deadlock reproduction using two different query plans.

**Tech Stack:** TypeScript strict, Prisma 6 (`$queryRaw` + `Prisma.sql`),
PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-16-ordered-class-locking-design.md`

## Global Constraints

- **Never start or restart the dev server on :3000.** The user runs it; the
  `integration` project talks to it over HTTP.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths
  containing parentheses.
- **One commit per task.** The PR is rebase-merged; the per-task history is the
  record.
- **Never write "does not close #N" / "does not fix #N"** in a commit message or
  PR body — GitHub's parser matches the keyword and ignores the negation. Write
  "**#N is unaffected**".
- **TypeScript strict, no `any`.** `noUncheckedIndexedAccess` is on: indexing an
  array yields `T | undefined`.
- **Run `npx vitest run --project unit <path>` as the inner loop**; run
  `npm run verify` before pushing.
- Every mutation must use a value the code under test cannot produce, and must be
  **restored and re-verified** in the same step.

## Verify-don't-assume

Line numbers below were checked against this checkout on 2026-08-16. Re-check
before leaning on one; if it has drifted, fix the reference and say so in the
task report.

```bash
sed -n '2p'        src/lib/db-locks.ts          # import type { Prisma } from '@prisma/client';
sed -n '193p'      src/lib/db-locks.ts          # export async function lockClassRow(
sed -n '48p'       src/lib/db-locks.test.ts     # async function _theBrandRejectsABareClient(
sed -n '402,409p'  src/services/gdpr.ts         # deleteStudentAccount's FOR UPDATE OF c
sed -n '860,862p'  src/services/gdpr.ts         # deleteTeacherAccount's `upcoming` read
sed -n '945,957p'  src/services/waitlist.ts     # withdrawWaitingEntriesForTeacher's statement
sed -n '113,123p'  src/services/template-sync.ts
sed -n '1251,1259p' src/services/class-template-lifecycle.ts
sed -n '1344p'     src/services/gdpr.test.ts    # the deadlock test
docker ps --format '{{.Names}}' | grep fairyoga-db-1
```

## Measured baseline (2026-08-16, this checkout)

```
npx vitest run --project unit   → 53 files, 769 tests, green
  src/services/template-lock-order.test.ts → 3 tests
  src/services/gdpr.test.ts               → 23 tests
  src/lib/db-locks.test.ts                → (count it in Task 1; unchanged by this plan except by addition)
```

Measure the after-figure; do not inherit it. This branch adds tests, so the
total will rise.

**Already verified against the real database — do not re-litigate:** splicing a
`Prisma.Sql` fragment into a `$queryRaw` tagged template merges parameters in
source order (`["probe-student","probe-type"]`), and `Prisma.empty` splices to
nothing while renumbering the remaining parameters correctly. Both executed
against Postgres without error.

---

### Task 1: The helper, and the brand that guards it

**Files:**
- Modify: `src/lib/db-locks.ts:2` (import), `:196` (insert helper after
  `lockClassRow`), `:169-188` (register), `:210-212` (module-safety docblock)
- Test: `src/lib/db-locks.test.ts` — imports, `_theBrandRejectsABareClient:48`,
  plus new behavioural tests

**Interfaces:**
- Produces: `lockClassRowsOrdered(tx: TransactionClientOnly, source: { join?: Prisma.Sql; where: Prisma.Sql }): Promise<string[]>`
  — returns the locked `Class` ids, deduped, ascending. Every later task consumes it.

- [ ] **Step 1: Write the failing behavioural tests**

Append to `src/lib/db-locks.test.ts`. Add `lockClassRowsOrdered` to the existing
`from './db-locks'` import block, and `import { Prisma } from '@prisma/client';`
(a value import — the file currently imports `PrismaClient` only).

```ts
describe('lockClassRowsOrdered', () => {
  const suffix = `dblocks-ordered-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let roomId: string;
  let lowClassId: string;
  let highClassId: string;
  let studentAId: string;
  let studentBId: string;

  beforeAll(async () => {
    // Ids chosen so ascending-by-id is knowable in advance, the convention
    // `template-lock-order.test.ts:154-155` uses.
    lowClassId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    highClassId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

    // `bio` and `pageSlug` are both required and unique-constrained — copied
    // from the working fixture at `gdpr.test.ts:1251`, not invented.
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock',
        lastName: 'Order',
        email: `${suffix}-teacher@test.local`,
        bio: 'Ordered-lock fixture',
        pageSlug: `${suffix}-teacher`,
        account: { create: { email: `${suffix}-teacher@test.local` } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Venue',
        address: 'Street 1',
        city: 'Town',
        postcode: '1234AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Ordered lock class',
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // HIGH inserted FIRST, so an unordered scan of this small table returns
    // physical order — the REVERSE of ascending by id. Asserted below, not
    // assumed.
    await prisma.class.create({ data: { ...base, id: highClassId, date: new Date('2099-06-01') } });
    await prisma.class.create({ data: { ...base, id: lowClassId, date: new Date('2099-06-02') } });

    const studentA = await prisma.student.create({
      data: {
        firstName: 'A',
        lastName: 'Student',
        email: `${suffix}-a@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-a@test.local` } },
      },
      select: { id: true },
    });
    studentAId = studentA.id;

    const studentB = await prisma.student.create({
      data: {
        firstName: 'B',
        lastName: 'Student',
        email: `${suffix}-b@test.local`,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-b@test.local` } },
      },
      select: { id: true },
    });
    studentBId = studentB.id;

    // TWO students on the SAME class, so a join that does not filter by
    // student returns that class twice. `@@unique([classId, studentId])`
    // means one student can never duplicate a class on their own, so this is
    // the only way to observe the dedupe.
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId: studentAId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId: studentBId, position: 2, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: highClassId, studentId: studentAId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: [lowClassId, highClassId] } } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [studentAId, studentBId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: { startsWith: suffix } } });
  });

  it('returns the locked ids ascending, whatever order the table stores them in', async () => {
    // The premise, asserted rather than assumed: unordered, this table hands
    // back insertion order, which is the REVERSE of ascending. If a planner
    // or storage change makes them agree, the assertion below stops proving
    // anything and this line fails loudly first.
    const heapOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c WHERE c."teacherId" = ${teacherId}
    `;
    expect(heapOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

    const locked = await prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, { where: Prisma.sql`c."teacherId" = ${teacherId}` }),
    );

    expect(locked).toEqual([lowClassId, highClassId]);
  });

  it('collapses a join that matches one class more than once', async () => {
    // Two `waiting` entries on `lowClassId`, so the join yields it twice.
    // Postgres refuses `DISTINCT` alongside `FOR UPDATE`, so the helper has
    // to collapse them itself — a caller that got two ids for one row would
    // lock once and iterate twice.
    const raw = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c
      JOIN "WaitlistEntry" w ON w."classId" = c.id
      WHERE c."teacherId" = ${teacherId}
    `;
    expect(raw.filter((r) => r.id === lowClassId)).toHaveLength(2);

    const locked = await prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, {
        join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
        where: Prisma.sql`c."teacherId" = ${teacherId}`,
      }),
    );

    expect(locked).toEqual([lowClassId, highClassId]);
  });

  it('bounds the rest of the transaction at the shared lock timeout', async () => {
    // Observes the effect rather than re-asserting the string that was sent
    // — the distinction the `SHOW` tests above this describe block make.
    const seen = await prisma.$transaction(async (tx) => {
      await lockClassRowsOrdered(tx, { where: Prisma.sql`c."teacherId" = ${teacherId}` });
      return tx.$queryRaw<Array<{ lock_timeout: string }>>`SHOW lock_timeout`;
    });
    expect(seen[0]?.lock_timeout).toBe('2s');
  });

  it('returns an empty array without erroring when nothing matches', async () => {
    const locked = await prisma.$transaction((tx) =>
      lockClassRowsOrdered(tx, { where: Prisma.sql`c."teacherId" = ${'no-such-teacher'}` }),
    );
    expect(locked).toEqual([]);
  });
});
```

Add `beforeAll` and `crypto` to the file's imports if not already present
(`import crypto from 'crypto';`, and `beforeAll` to the `vitest` import).

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts
```

Expected: FAIL — `lockClassRowsOrdered is not exported by './db-locks'` (or a
TypeScript resolution error naming the same symbol).

- [ ] **Step 3: Change the `Prisma` import to a value import**

`src/lib/db-locks.ts:2`:

```ts
import { Prisma } from '@prisma/client';
```

was `import type { Prisma } from '@prisma/client';`. `Prisma.empty` is a value.
The same identifier still serves `Prisma.TransactionClient` as a type.

- [ ] **Step 4: Add the helper after `lockClassRow`**

Insert after `src/lib/db-locks.ts:196` (the closing brace of `lockClassRow`),
before the `ANNOUNCEMENT_DEDUPE_WINDOW_MS` docblock:

```ts
/**
 * Locks many `Class` rows in one statement, ascending by id, with a bounded
 * wait — and hands back the ids it holds.
 *
 * This is the only production `SELECT … FOR UPDATE OF c` in `src/`. Before
 * #237 there were four, plus a fifth site that took its locks through a
 * per-class CAS loop, and which sites those were was tracked in prose:
 * a five-row table in `docs/lock-order.md` and the register above. That table
 * was corrected about its own membership four times — most recently by the
 * round that filed this issue, which added `deleteStudentAccount`'s statement
 * to the table and not to the derivation below it. A convention tracked by
 * prose goes stale; this function is the convention.
 *
 * FOUR things are deliberately here rather than at the call sites, because
 * each is a thing a call site got wrong at least once in this codebase's
 * history:
 *
 *   `ORDER BY c.id` — two transactions taking the same pair of `Class` rows
 *     in opposite sequences is an AB-BA cycle, and Postgres resolves it by
 *     killing one side with `40P01`. Reproduced for real in issue 180 and
 *     again in #174's whole-branch review. Pinned by
 *     `db-locks-lock-order.test.ts`, which contends two DIFFERENT query plans
 *     over the same rows — two callers sharing one predicate produce one plan,
 *     scan one physical order, and serialise with or without this clause, so
 *     a same-predicate pairing could never have pinned it.
 *
 *   `FOR UPDATE OF c` — never a bare `FOR UPDATE`, which on a joined query
 *     also locks the `WaitlistEntry` rows and adds wait edges
 *     `docs/lock-order.md` does not model.
 *
 *   `setLockTimeout` — the shared 2s bound, so no adopting transaction can
 *     block indefinitely on a row the 60-second transitions sweep holds. It
 *     governs the whole rest of the caller's transaction, not just this
 *     statement; `SET LOCAL` is transaction-scoped and resets on COMMIT or
 *     ROLLBACK however the transaction ends. Callers that also issue it
 *     themselves are safe — a later `SET LOCAL lock_timeout` overwrites the
 *     earlier one rather than stacking.
 *
 *   the dedupe — Postgres refuses `DISTINCT` alongside `FOR UPDATE`, so a
 *     join matching one class twice hands back two ids for one locked row.
 *     Order is preserved: `Set` iterates in insertion order and the rows
 *     arrive ascending.
 *
 * The predicate is a composed `Prisma.Sql`, not a typed selector, and that was
 * the decision this issue existed to make. A union of typed selectors cannot
 * go stale — the compiler forces a member per site — but it IS the five-row
 * table re-expressed as a type, and it would make this module know every one
 * of its callers by name and carry their domain types. The predicate was never
 * what went stale; the site list was. A fragment is also not a loophole: a
 * caller that references `w.` without supplying a `join`, or writes its own
 * `ORDER BY` or `FOR UPDATE`, gets a SQL error, not a silently wrong lock.
 * Parameters are bound — `Prisma.sql` tagged templates merge their values into
 * this statement in source order, verified against Postgres — so nothing here
 * is interpolated unless a caller reaches for `Prisma.raw`, which in `src/` is
 * used once, for a frozen constant (`SCHEDULED_STATUSES_SQL`,
 * `class-template-lifecycle.ts`).
 *
 * Returning the ids is not a convenience. It lets a caller scope its write to
 * `id: { in: … }` so the write set is a structural SUBSET of the lock set,
 * rather than a predicate re-evaluated later against whatever the table looks
 * like when the write runs — the difference `docs/lock-order.md` draws between
 * `syncTemplateInstances` and `archiveOrUnarchiveTemplate`. Callers that do
 * not need them may ignore the return value; the lock is the point.
 *
 * NOT for single-row locks — use `lockClassRow` above. One row cannot be
 * ordered against itself, and that helper's signature says so.
 *
 * Branded `TransactionClientOnly` per this module's rule: on a bare client the
 * `SET LOCAL` and the `FOR UPDATE` would each land in their own autocommit
 * transaction and protect nothing. See `lockClassRow`'s docblock for why
 * `Prisma.TransactionClient` alone does not enforce that.
 */
export async function lockClassRowsOrdered(
  tx: TransactionClientOnly,
  source: { join?: Prisma.Sql; where: Prisma.Sql },
): Promise<string[]> {
  await setLockTimeout(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM "Class" c
    ${source.join ?? Prisma.empty}
    WHERE ${source.where}
    ORDER BY c.id
    FOR UPDATE OF c
  `;
  return [...new Set(rows.map((row) => row.id))];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run --project unit src/lib/db-locks.test.ts
```

Expected: PASS, including the four new tests.

- [ ] **Step 6: Add the brand pin**

In `src/lib/db-locks.test.ts`, inside `_theBrandRejectsABareClient` (`:48`),
after the `lockClassRow` entry:

```ts
  // @ts-expect-error `SET LOCAL` then `FOR UPDATE OF c` — the multi-row twin
  // of the line above, and the same failure on a bare client.
  await lockClassRowsOrdered(client, { where: Prisma.sql`c."id" = ${'never-called'}` });
```

- [ ] **Step 7: Prove the brand pin bites**

```bash
npx tsc --noEmit
```
Expected: PASS.

Now mutate: change the new parameter's type in `db-locks.ts` from
`TransactionClientOnly` to `Prisma.TransactionClient`, re-run `npx tsc --noEmit`.

Expected: FAIL with `Unused '@ts-expect-error' directive.` on the line added in
Step 6 — and **only** that line, which is what proves the directives are
per-function rather than one covering the rest.

Record the exact error text in the task report. Restore
`TransactionClientOnly`, re-run `npx tsc --noEmit`, confirm PASS.

- [ ] **Step 8: Correct the module-safety docblock**

`src/lib/db-locks.ts:210-212` currently reads "This module is safe to import
from a test because it pulls in only `crypto` and a Prisma type — never
`@/lib/log`, which is pino and server-only."

The Prisma import is now a value import. Replace that sentence with:

```
 * This module is safe to import from a test because it pulls in only `crypto`
 * and `@prisma/client` — never `@/lib/log`, which is pino and server-only. The
 * `Prisma` import became a VALUE import in #237 (`Prisma.empty`, spliced by
 * `lockClassRowsOrdered`), so this module now pulls the generated client into
 * whatever imports it. Checked at that time: no `'use client'` component
 * imports `@/lib/db-locks` — every importer is a service, an API route or a
 * test. Re-check before importing this module from a client component; a
 * bundled Prisma client is the same class of failure as a bundled pino.
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/db-locks.ts src/lib/db-locks.test.ts
git commit -m "feat: one helper for ordered multi-row Class locking

Owns the four things a call site got wrong at least once here: ORDER BY
c.id, FOR UPDATE OF c rather than a bare FOR UPDATE, the shared 2s bound,
and the dedupe Postgres forces by refusing DISTINCT alongside FOR UPDATE.
Returns the locked ids so a caller can scope its write to them.

Takes a composed Prisma.Sql predicate rather than a typed selector union.
The union cannot go stale, but it is the five-row table re-expressed as a
type: it would make db-locks.ts know every caller by name and carry their
domain types. The site list is what went stale four times; the predicate
never did.

Prisma becomes a value import here (Prisma.empty). Verified no 'use client'
component imports this module, and the module docblock now says so."
```

---

### Task 2: Pin the ordering with a reproduction that can fail

**Files:**
- Create: `src/lib/db-locks-lock-order.test.ts`

**Interfaces:**
- Consumes: `lockClassRowsOrdered` from Task 1.

**Why this shape, and why the obvious shape does not work:** two callers with
the same predicate produce the same plan, scan the same physical order, and
serialise with or without `ORDER BY`. The clause is load-bearing only between
two *different* plans — a `WaitlistEntry` join returns classes in
`WaitlistEntry` order, a plain `Class` scan returns them in `Class` order, and
those two can disagree. The fixture makes them disagree on purpose.

- [ ] **Step 1: Write the failing test**

Create `src/lib/db-locks-lock-order.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { lockClassRowsOrdered } from './db-locks';

const prisma = new PrismaClient();

/**
 * The guard `lockClassRowsOrdered`'s `ORDER BY c.id` exists to be, and the
 * one this project owed after #216/#182: with both sides of a pairing taking
 * every lock in a single ordered statement, the per-pairing reproductions in
 * `template-lock-order.test.ts` can no longer CONSTRUCT an AB-BA cycle, so
 * they no longer detect a missing `ORDER BY` on the erasure side (verified:
 * deleting it leaves all three green). Testing the shared primitive once
 * repays that for every call site at the same time.
 *
 * WHY TWO DIFFERENT PLANS, and not two calls with the same predicate. Two
 * identical statements produce one plan, visit one physical order, and
 * serialise whether or not the clause is there — such a test passes against
 * the bug and proves nothing. `ORDER BY c.id` is load-bearing only where two
 * sites reach the same rows by DIFFERENT plans: the join below is driven by
 * `WaitlistEntry` and returns classes in that table's physical order, while
 * the scan is driven by `Class` and returns them in its own. The fixture
 * inserts the two tables in OPPOSITE orders so the two natural orders
 * disagree, and both premises are asserted before the race rather than
 * assumed — a planner or storage change that makes them agree fails loudly
 * here instead of leaving the test green for an unrelated reason.
 *
 * WHY A THIRD TRANSACTION. Both callers take their locks inside one statement
 * each, so there is no application-level window to interleave — the same
 * property that made the per-pairing reproductions unconstructible. Holding
 * both rows from a third transaction and releasing them parks one caller on
 * each row first, so the collision is deterministic rather than a race this
 * test hopes to win. Same technique as `gdpr.test.ts`'s "a third transaction
 * takes the `Student` row `FOR UPDATE` before either".
 */
describe('lockClassRowsOrdered takes multiple Class rows in one order', () => {
  const suffix = `dblocks-order-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let roomId: string;
  let studentId: string;
  let lowClassId: string;
  let highClassId: string;

  beforeAll(async () => {
    lowClassId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    highClassId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

    // `bio` and `pageSlug` are both required and unique-constrained — copied
    // from the working fixture at `gdpr.test.ts:1251`, not invented.
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Order',
        lastName: 'Teacher',
        email: `${suffix}-teacher@test.local`,
        bio: 'Ordered-lock fixture',
        pageSlug: `${suffix}-teacher`,
        account: { create: { email: `${suffix}-teacher@test.local` } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Venue',
        address: 'Street 1',
        city: 'Town',
        postcode: '1234AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Order class',
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // Classes: HIGH first, so the `Class` scan's natural order is [HIGH, LOW].
    await prisma.class.create({ data: { ...base, id: highClassId, date: new Date('2099-06-01') } });
    await prisma.class.create({ data: { ...base, id: lowClassId, date: new Date('2099-06-02') } });

    const student = await prisma.student.create({
      data: {
        firstName: 'Order',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-student@test.local` } },
      },
      select: { id: true },
    });
    studentId = student.id;

    // Entries: LOW first — the OPPOSITE order to the classes above, which is
    // the whole point. It makes the join's natural order [LOW, HIGH] against
    // the scan's [HIGH, LOW].
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: highClassId, studentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { studentId } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: { startsWith: suffix } } });
    await prisma.$disconnect();
  });

  it('serialises two callers whose natural orders disagree, instead of deadlocking', async () => {
    // Premise 1: the scan's natural order.
    const scanOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c WHERE c."teacherId" = ${teacherId}
    `;
    expect(scanOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

    // Premise 2: the join's natural order — the REVERSE. Asserting premise 1
    // proves nothing about this: different tables, different physical layouts.
    const joinOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c
      JOIN "WaitlistEntry" w ON w."classId" = c.id
      WHERE w."studentId" = ${studentId}
    `;
    expect(joinOrder.map((r) => r.id)).toEqual([lowClassId, highClassId]);

    // The third transaction: holds BOTH rows so each caller below parks on
    // the first row ITS plan reaches, rather than racing for the same one.
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderReady!: () => void;
    const holderHasRows = new Promise<void>((resolve) => {
      holderReady = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "Class" WHERE id IN (${lowClassId}, ${highClassId}) FOR UPDATE
        `;
        holderReady();
        await holderReleased;
      },
      { timeout: 10_000 },
    );

    await holderHasRows;

    // Caller A: the JOIN plan. Unordered it wants LOW first.
    const a = prisma.$transaction(
      async (tx) => {
        const ids = await lockClassRowsOrdered(tx, {
          join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
          where: Prisma.sql`w."studentId" = ${studentId}`,
        });
        // Held briefly so the other caller genuinely queues behind these rows
        // rather than sailing through uncontended — without this the
        // no-deadlock result would also be satisfied by two transactions that
        // never overlapped at all. Well inside the 2s `lock_timeout` the
        // helper sets.
        await new Promise((r) => setTimeout(r, 250));
        return ids;
      },
      { timeout: 10_000 },
    );

    // Caller B: the SCAN plan. Unordered it wants HIGH first.
    const b = prisma.$transaction(
      async (tx) => {
        const ids = await lockClassRowsOrdered(tx, {
          where: Prisma.sql`c."teacherId" = ${teacherId}`,
        });
        await new Promise((r) => setTimeout(r, 250));
        return ids;
      },
      { timeout: 10_000 },
    );

    // Both are now queued on rows the holder owns. Release it: each is
    // granted the row its own plan asked for first, and then reaches for the
    // other's.
    await new Promise((r) => setTimeout(r, 300));
    releaseHolder();
    await holder;

    const [aSettled, bSettled] = await Promise.allSettled([a, b]);

    // SQLSTATE first, THEN the value — and the order is the point. A bare
    // `expect(status).toBe('fulfilled')` reports "expected 'rejected' to be
    // 'fulfilled'" and names nothing: a `40P01`, a `55P03` and a broken
    // fixture look identical in that output.
    for (const [label, settled] of [
      ['join caller', aSettled],
      ['scan caller', bSettled],
    ] as const) {
      if (settled.status === 'rejected') {
        const message = String(settled.reason);
        expect(`${label}: ${message}`).not.toMatch(/40P01|deadlock detected/);
        expect(`${label}: ${message}`).not.toMatch(/55P03|lock timeout/);
        throw new Error(`${label} rejected unexpectedly: ${message}`);
      }
    }

    // Lock EXISTENCE, not just lock ORDER: two ids each proves both callers
    // actually matched and actually held both fixture rows. Without this a
    // predicate that matched nothing would satisfy the no-deadlock assertion
    // above perfectly.
    expect(aSettled.status === 'fulfilled' && aSettled.value).toEqual([lowClassId, highClassId]);
    expect(bSettled.status === 'fulfilled' && bSettled.value).toEqual([lowClassId, highClassId]);
  });
});
```

- [ ] **Step 2: Run it to verify it passes against correct code**

```bash
npx vitest run --project unit src/lib/db-locks-lock-order.test.ts
```

Expected: PASS. (This test asserts the ABSENCE of a deadlock, so it passes on
correct code first — Step 3 is what proves it is not vacuous.)

- [ ] **Step 3: Prove it bites — the step this task exists for**

Mutate `src/lib/db-locks.ts`: delete the `ORDER BY c.id` line from
`lockClassRowsOrdered`'s statement. Re-run:

```bash
npx vitest run --project unit src/lib/db-locks-lock-order.test.ts
```

Expected: FAIL, naming `40P01` / `deadlock detected` in the message.

Record the exact error text in the task report. Restore the clause, re-run,
confirm PASS.

If it does NOT fail, do not adjust the assertion to make it fail. Report it —
the likely cause is a premise assertion that passed while the planner chose a
different drive table, and the fix is the fixture, not the expectation.

- [ ] **Step 4: Prove it bites the OTHER regression**

Mutate again: change `ORDER BY c.id` to `ORDER BY c.id DESC`. Re-run.

Expected: FAIL with `40P01`. An inversion is the realistic regression — a
plausible edit that reads as a preference — where deletion is the obvious one.
Record, restore, re-verify.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db-locks-lock-order.test.ts
git commit -m "test: pin the lock order with two plans, not two callers

Two callers sharing a predicate produce one plan, visit one physical
order, and serialise with or without ORDER BY — such a test passes
against the bug. This contends the WaitlistEntry join against a plain
Class scan, with the two tables seeded in opposite orders so their natural
orders disagree, and both premises asserted before the race.

A third transaction holds both rows and releases them, so each caller
parks on the row its own plan reaches first and the collision is
deterministic rather than a race.

Proved by mutation twice: deleting ORDER BY c.id and inverting it to DESC
each fail with 40P01. Restored and re-verified."
```

---

### Task 3: Convert `withdrawWaitingEntriesForTeacher`

**Files:**
- Modify: `src/services/waitlist.ts:10` (import), `:14` (import), `:940-957`

**Interfaces:**
- Consumes: `lockClassRowsOrdered` (Task 1).

Converted first because `db-locks.test.ts`'s brand list already imports this
function, so any signature surprise surfaces against a test that already exists.

- [ ] **Step 1: Make the `Prisma` import a value import**

`src/services/waitlist.ts:10` is
`import type { PrismaClient, Prisma, CancelDeadline, WaitlistEntry } from '@prisma/client';`.
`Prisma.sql` is a value. Split it:

```ts
import { Prisma } from '@prisma/client';
import type { PrismaClient, CancelDeadline, WaitlistEntry } from '@prisma/client';
```

- [ ] **Step 2: Add the helper to the `db-locks` import**

`src/services/waitlist.ts:14`:

```ts
import { lockClassRow, lockClassRowsOrdered, type TransactionClientOnly } from '@/lib/db-locks';
```

- [ ] **Step 3: Replace the statement**

Replace `src/services/waitlist.ts:940-957` — the comment block, the
`$queryRaw`, the `if (locked.length === 0) return;` and the `classIds` line —
with:

```ts
  // Through the shared helper (#237), which owns the `ORDER BY c.id`, the
  // `FOR UPDATE OF c` that keeps this join from also locking the
  // `WaitlistEntry` rows, the 2s bound and the dedupe this call site used to
  // do itself. `FOR UPDATE OF c` locks the same rows `addToWaitlist`,
  // `promoteNext`, `claimSpot` and `removeFromWaitlist` lock singly.
  const classIds = await lockClassRowsOrdered(tx, {
    join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
    where: Prisma.sql`c."teacherId" = ${input.teacherId}
      AND w."studentId" = ${input.studentId}
      AND w.status = 'waiting'`,
  });
  if (classIds.length === 0) return;
```

The local `locked` and the `[...new Set(...)]` are gone — the helper dedupes.
Everything below (`waitlistEntry.updateMany`, the `reorderWaitingEntries`
loop) is unchanged and still reads `classIds`.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run --project unit src/services/waitlist.test.ts src/lib/db-locks.test.ts src/services/invitations-lock-order.test.ts
npx tsc --noEmit
```

Expected: PASS. Report the test counts.

- [ ] **Step 5: Commit**

```bash
git add src/services/waitlist.ts
git commit -m "refactor: withdrawWaitingEntriesForTeacher takes its locks through the helper

Drops its own new Set — the helper dedupes, which every joined caller
needs because Postgres refuses DISTINCT alongside FOR UPDATE."
```

---

### Task 4: Convert `deleteStudentAccount`

**Files:**
- Modify: `src/services/gdpr.ts:13` (import), `:18` (import), `:402-409`

**Interfaces:**
- Consumes: `lockClassRowsOrdered` (Task 1).

**Do NOT remove the `setLockTimeout(tx)` call at `gdpr.ts:340`.** It is not
redundant with the helper's: a `tx.registration.findMany` runs between line 340
and the lock statement, and that read is bounded only by the earlier call. The
helper re-issuing `SET LOCAL` later is safe — a second one overwrites the first
rather than stacking.

- [ ] **Step 1: Add the imports**

`src/services/gdpr.ts:13`, add a value import above the existing type import:

```ts
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
```

`src/services/gdpr.ts:18`:

```ts
import { lockClassRowsOrdered, setLockTimeout } from '@/lib/db-locks';
```

- [ ] **Step 2: Replace the statement**

Replace `src/services/gdpr.ts:402-409` (the `await tx.$queryRaw` template
literal only — keep the long comment block above it, which explains the write
set and the "EVERY status" decision) with:

```ts
    await lockClassRowsOrdered(tx, {
      join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
      where: Prisma.sql`w."studentId" = ${studentId}`,
    });
```

Then edit the comment block above it: the sentence beginning "The same shape
`withdrawWaitingEntriesForTeacher` (`waitlist.ts`) uses, for the same reasons:
ascending by `c.id` … `FOR UPDATE OF c` so only the `Class` rows are locked …
No `DISTINCT`: Postgres refuses it alongside `FOR UPDATE`" now describes the
helper rather than this statement. Rewrite it as:

```
    // Through the shared helper (#237), which owns all of that: ascending by
    // `c.id` so two concurrent erasures take any shared classes in one order,
    // `FOR UPDATE OF c` so only the `Class` rows are locked, the dedupe
    // Postgres forces by refusing `DISTINCT` alongside `FOR UPDATE`, and — the
    // part a loop cannot have — the lock taken BY the statement that chooses
    // the rows, so there is no window between choosing them and holding them.
    // `@@unique([classId, studentId])` means one entry per class per student,
    // so this join could not duplicate a class anyway; the helper's dedupe is
    // for its other callers.
```

Keep the "EVERY status, matching the unscoped `deleteMany` below" paragraph
exactly as it is — it explains the predicate, which has not changed.

- [ ] **Step 3: Rename `sortedWaitingClassIds`**

`src/services/gdpr.ts:416` declares `sortedWaitingClassIds` from a `findMany`
with no `orderBy` and no `.sort()`. There is no `.sort()` anywhere in this
file — the name survived #216/#182's rewrite, which moved the ordering into
SQL. Rename it to `waitingClassIds` at its declaration (`:416`), at its use in
the reorder loop (`:606`), and in the comment at `:323` that names it.

```bash
grep -n "sortedWaitingClassIds" src/services/gdpr.ts   # must return nothing afterwards
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run --project unit src/services/gdpr.test.ts src/services/template-lock-order.test.ts
npx tsc --noEmit
```

Expected: PASS — 23 tests in `gdpr.test.ts`, 3 in `template-lock-order.test.ts`.

- [ ] **Step 5: Prove the conversion kept the guard**

Mutate `src/lib/db-locks.ts`: delete `ORDER BY c.id`. Run:

```bash
npx vitest run --project unit src/services/gdpr.test.ts
```

Expected: FAIL — `gdpr.test.ts:1344` ("does not deadlock when a teacher erasure
and a student erasure overlap on two classes") with `40P01`. This is the
reproduction that survived #216/#182; it must survive this conversion too,
because `deleteTeacherAccount` still takes its locks in a per-class loop at this
point in the branch.

Record the error text. Restore, re-run, confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/gdpr.ts
git commit -m "refactor: deleteStudentAccount takes its locks through the helper

Also renames sortedWaitingClassIds to waitingClassIds. Nothing sorts it —
there is no .sort() anywhere in this file. The name survived the rewrite
that moved the ordering into SQL, and a variable named for an operation
that no longer exists is the same class of stale claim this branch is
about.

Verified the conversion kept the guard: deleting ORDER BY c.id from the
helper still fails the teacher-vs-student erasure reproduction with 40P01."
```

---

### Task 5: Convert `syncTemplateInstances`

**Files:**
- Modify: `src/services/template-sync.ts:17` (import), `:113-123`

**Interfaces:**
- Consumes: `lockClassRowsOrdered` (Task 1).

- [ ] **Step 1: Add the imports**

`src/services/template-sync.ts:17`:

```ts
import { lockClassRowsOrdered, type TransactionClientOnly } from '@/lib/db-locks';
```

`setLockTimeout` is no longer imported directly here — the helper issues it, and
this file's only call was the one immediately above the statement. Add a value
import for `Prisma` (this file has none today):

```ts
import { Prisma } from '@prisma/client';
```

- [ ] **Step 2: Replace the statement**

Replace `src/services/template-sync.ts:113-123` (`await setLockTimeout(tx);`
through `const lockedIds = locked.map((row) => row.id);`) with:

```ts
  const lockedIds = await lockClassRowsOrdered(tx, {
    where: Prisma.sql`c."templateId" = ${templateId}
      AND c."teacherId" = ${template.teacherId}
      AND c.date > ${lockBound}`,
  });
```

Keep the comment block above it unchanged — including the "`lockBound`, not
`now`" note, which is about the predicate and still true, and the sentence
about the returned ids being "captured, not discarded", which is now the
helper's documented contract.

- [ ] **Step 3: Run the tests**

```bash
npx vitest run --project unit src/services/template-sync.test.ts src/services/template-lock-order.test.ts src/services/class-template-lifecycle.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Prove the pre-lock still bites**

`template-lock-order.test.ts`'s mutations are aimed at this side. Mutate
`src/services/template-sync.ts`: delete the whole `lockClassRowsOrdered` call.
Run `npx vitest run --project unit src/services/template-lock-order.test.ts`.

Expected: FAIL with `40P01`. Record, restore, re-verify.

- [ ] **Step 5: Commit**

```bash
git add src/services/template-sync.ts
git commit -m "refactor: syncTemplateInstances takes its pre-lock through the helper

Keeps id: { in: lockedIds } on the re-read — the returned ids are now the
helper's documented contract rather than this call site's own arrangement."
```

---

### Task 6: Convert `archiveOrUnarchiveTemplate`

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:35` (import), `:1251-1259`

**Interfaces:**
- Consumes: `lockClassRowsOrdered` (Task 1).

`Prisma` is already a value import here (`:26`). Leave `SCHEDULED_STATUSES_SQL`
(`:664`) exactly as it is, including its `Prisma.raw` — a bound status parameter
needs a `::text` cast that was measured to cost the index this predicate relies
on.

- [ ] **Step 1: Add the import**

`src/services/class-template-lifecycle.ts:35`:

```ts
import { lockClassRowsOrdered, setLockTimeout } from '@/lib/db-locks';
```

`setLockTimeout` stays — check whether this file has other callers of it before
removing anything (`grep -n "setLockTimeout" src/services/class-template-lifecycle.ts`).
If the pre-lock was its only caller, drop it from the import.

- [ ] **Step 2: Replace the statement**

Replace `src/services/class-template-lifecycle.ts:1251-1259` (the
`await tx.$queryRaw` template literal) with:

```ts
        await lockClassRowsOrdered(tx, {
          where: Prisma.sql`c."templateId" = ${templateId}
            AND c.date > ${today}
            AND c.status IN (${SCHEDULED_STATUSES_SQL})`,
        });
```

Keep the long comment block above it verbatim — it documents the `date > today`
residual, which this branch does not close and the collapsed lock-order table
still names.

- [ ] **Step 3: Run the tests**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts src/services/template-lock-order.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Prove the status list is still load-bearing**

`class-template-lifecycle.ts:641-651` records a measured instance of this
desync silently re-opening a deadlock. Confirm it is still guarded: mutate
`SCHEDULED_STATUSES` (`:631`) to `['open']` — dropping `'draft'` — and run
`npx vitest run --project unit src/services/template-lock-order.test.ts src/services/class-template-lifecycle.test.ts`.

Record what happens. If nothing fails, say so plainly in the task report and do
not invent a test for it — it is a pre-existing coverage gap, not this task's
deliverable, and misreporting it is worse than leaving it. Restore either way.

- [ ] **Step 5: Commit**

```bash
git add src/services/class-template-lifecycle.ts
git commit -m "refactor: archiveOrUnarchiveTemplate takes its pre-lock through the helper

SCHEDULED_STATUSES_SQL keeps its Prisma.raw rendering — a bound status
parameter needs a ::text cast that was measured to cost this predicate's
index."
```

---

### Task 7: One status list for `deleteTeacherAccount`

**Files:**
- Modify: `src/services/gdpr.ts` — add constants near the top, use at `:861` and
  in the cancel CAS `where`

**Interfaces:**
- Produces: `CANCELLABLE_STATUSES: readonly ClassStatus[]` and
  `CANCELLABLE_STATUSES_SQL: Prisma.Sql`, consumed by Task 8.

No behaviour change. Separated from Task 8 so a reviewer can judge the
deduplication and the lock fold independently.

- [ ] **Step 1: Add the constants**

In `src/services/gdpr.ts`, above `deleteTeacherAccount`:

```ts
/**
 * The statuses a teacher erasure cancels — and the ONE list they are read
 * from.
 *
 * This was hand-typed twice in `deleteTeacherAccount` (the `upcoming` read's
 * filter and the per-class CAS `where` it must agree with), and the ordered
 * pre-lock would have made three. `class-template-lifecycle.ts:641-651`
 * records what that costs, measured rather than argued: dropping a status
 * from one of two hand-written lists "left every test covering this function
 * green, silently re-opening the deadlock the pre-lock exists to close".
 * There is one list to edit now, not three to keep in sync.
 */
const CANCELLABLE_STATUSES: readonly ClassStatus[] = Object.freeze([
  'draft',
  'open',
  'in_progress',
]);

/**
 * `CANCELLABLE_STATUSES`, pre-rendered as a raw SQL `IN (…)` list for the
 * ordered pre-lock's predicate — the one reader of it that cannot go through a
 * Prisma `{ in: [...] }` filter, because `FOR UPDATE OF c` and `ORDER BY` have
 * no query-builder equivalent.
 *
 * `Prisma.raw`, not `Prisma.join`, following `SCHEDULED_STATUSES_SQL`
 * (`class-template-lifecycle.ts:653`) and for the reason measured there:
 * `Prisma.join` binds each status as a separate parameter, and a bound text
 * parameter compared against the `status` column's enum type needs an explicit
 * `::text` cast to resolve, which costs the index. Safe here for the same one
 * precondition as there — `CANCELLABLE_STATUSES` is a frozen, hard-coded
 * constant, never input.
 */
const CANCELLABLE_STATUSES_SQL = Prisma.raw(CANCELLABLE_STATUSES.map((s) => `'${s}'`).join(', '));
```

Add `ClassStatus` to the type import at `src/services/gdpr.ts:13`:

```ts
import type { PrismaClient, ClassStatus } from '@prisma/client';
```

- [ ] **Step 2: Use it at both existing sites**

`src/services/gdpr.ts:861` — the `upcoming` read:

```ts
        where: { teacherId, status: { in: [...CANCELLABLE_STATUSES] } },
```

and the cancel CAS `where` a few lines below:

```ts
          where: { id: cls.id, status: { in: [...CANCELLABLE_STATUSES] } },
```

The spread is required: Prisma's generated `in` expects a mutable array, and
`CANCELLABLE_STATUSES` is `readonly`. Do not drop `readonly` from the constant
to avoid the spread — the freeze is what makes `Prisma.raw` defensible.

- [ ] **Step 3: Run the tests**

```bash
npx vitest run --project unit src/services/gdpr.test.ts
npx tsc --noEmit
```

Expected: PASS, 23 tests.

- [ ] **Step 4: Prove the two lists are actually joined**

Mutate `CANCELLABLE_STATUSES` to `['draft', 'open']` — dropping
`'in_progress'`. Run `npx vitest run --project unit src/services/gdpr.test.ts`.

Expected: FAIL — the erasure now leaves `in_progress` classes uncancelled, and
`gdpr.test.ts` covers that path. Record the failing test name and the message.
Restore, re-run, confirm PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/gdpr.ts
git commit -m "refactor: one list of the statuses a teacher erasure cancels

Hand-typed twice today and the pre-lock would have made three. The SQL
twin is derived from the same frozen array via Prisma.raw, following
SCHEDULED_STATUSES_SQL and for the index reason measured there."
```

---

### Task 8: Fold `deleteTeacherAccount` in, and re-point the test it makes vacuous

**Files:**
- Modify: `src/services/gdpr.ts` — insert pre-lock before `:860`
- Modify: `src/services/gdpr.test.ts:~1325-1329` (fixture), `:1344` (the test)

**Interfaces:**
- Consumes: `lockClassRowsOrdered` (Task 1), `CANCELLABLE_STATUSES_SQL` (Task 7).

**This task is one task on purpose.** The fold removes the window
`gdpr.test.ts:1344`'s hook interleaves into, so between the fold and the
re-point that test passes while guarding nothing. Splitting them would commit
that state. The steps below measure the vacuity rather than assuming it.

**Two decisions already made — do not revisit:**
- The `upcoming` read stays **wide** and the per-class CAS **stays**. Scoping the
  read to the pre-lock's ids would make the write set a structural subset of the
  lock set, but a class created between pre-lock and read would then escape the
  erasure entirely — an Article 17 gap traded for a guarantee the CAS already
  provides.
- The transaction is **newly bounded at 2s** per statement, because the helper
  issues `setLockTimeout` and this transaction issues none today. Deliberate;
  `api/account/route.ts` already maps the resulting `55P03` to a retryable 503.
  Do **not** resize its `{ timeout: 10_000 }`.

- [ ] **Step 1: Add the pre-lock**

In `src/services/gdpr.ts`, immediately before the `const upcoming =` read
(`:860`), inside the `db.$transaction` callback:

```ts
      // Every class this erasure may cancel, locked ascending in ONE statement
      // before the read below — #237.
      //
      // What this replaces: the `orderBy: { id: 'asc' }` on that read, which
      // WAS this transaction's lock acquisition order, because the loop below
      // takes one `Class` row lock per iteration (the CAS `UPDATE`) and the
      // read is not itself under any lock. That worked, and it depended on a
      // reader noticing that an `orderBy` on an unlocked read was load-bearing.
      // The `orderBy` stays for determinism of the notification order; it is no
      // longer what orders the locks.
      //
      // Additive, not a replacement for the CAS. The read stays WIDE and the
      // per-class compare-and-swap below stays exactly as it was: a class
      // inserted between this statement and that read is not held here, and
      // the CAS is what handles it. Scoping the read to these ids — the
      // `syncTemplateInstances` shape — would make the write set a structural
      // subset of the lock set and let such a class escape the erasure
      // altogether, which is a worse trade on an Article 17 path than the one
      // the CAS already makes.
      //
      // This also brings the shared 2s `lock_timeout` into a transaction that
      // had none, so every statement in it is now bounded rather than waiting
      // out Prisma's `{ timeout: 10_000 }` — which cannot roll back a
      // statement already blocked inside Postgres, only refuse to start a new
      // one (`gdpr.ts:692`). Deliberate: the same argument
      // `deleteStudentAccount` makes for its own bound applies here, since
      // Article 17 does not distinguish which subject is being erased, and
      // `api/account/route.ts` already answers the resulting `55P03` with a
      // retryable 503.
      await lockClassRowsOrdered(tx, {
        where: Prisma.sql`c."teacherId" = ${teacherId}
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})`,
      });
```

Then edit the `orderBy` comment above the `upcoming` read: the sentence
"`orderBy` is load-bearing, not tidiness: the loop below takes one `Class` row
lock per iteration (the CAS `UPDATE`), so the order this read returns IS this
transaction's lock acquisition order" is no longer true. Replace that clause
with a pointer to the pre-lock above, keeping the rest of the paragraph (the
issue-180 history and the `docs/lock-order.md` reference) intact.

- [ ] **Step 2: Measure the vacuity — do not assume it**

Run the test as it stands:

```bash
npx vitest run --project unit src/services/gdpr.test.ts
```
Expected: PASS, 23 tests.

Now mutate `src/lib/db-locks.ts`: delete `ORDER BY c.id`. Re-run.

Expected: **PASS** — which is the finding. Before this task that mutation failed
this file with `40P01` (Task 4 Step 5 recorded it). The hook at `casCalls === 1`
now fires with every lock already held, so there is nothing to interleave.

Record both results in the task report. Restore the clause.

- [ ] **Step 3: Flip the fixture so the two natural orders disagree**

This is the step that decides whether the re-point works. Both sides now share
one `ORDER BY`, so deleting it leaves the teacher side taking `Class`-scan order
and the student side taking `WaitlistEntry`-join order. In the current fixture
those two **agree** — classes are inserted HIGH then LOW, and so are the
waitlist entries — so the mutation would produce no cycle and the test would
pass on broken code.

In `src/services/gdpr.test.ts`, in the `beforeAll` around `:1325-1329`, swap the
two `waitlistEntry.create` calls so `LOW_CLASS_ID` is inserted first:

```ts
    // Waiting in BOTH classes: that is what makes `deleteStudentAccount` lock
    // two `Class` rows, which is the only way the orders can disagree.
    //
    // LOW first — the OPPOSITE order to the classes above, and since #237 that
    // opposition is what the test turns on. Both erasures take their locks
    // through `lockClassRowsOrdered`, so one `ORDER BY` orders both sides;
    // the only way its removal can still produce a cycle is if the two
    // callers' NATURAL orders differ, and they differ only because these two
    // tables are seeded in opposite orders. Insert these HIGH-first and the
    // mutation below stops reproducing anything.
    await prisma.waitlistEntry.create({
      data: { classId: LOW_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: HIGH_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
```

- [ ] **Step 4: Re-point the hook and the premise assertion**

In the test at `:1344`:

- The `waitlistHeapOrder` premise assertion currently expects
  `[HIGH_CLASS_ID, LOW_CLASS_ID]`. After Step 3 it must expect
  `[LOW_CLASS_ID, HIGH_CLASS_ID]`. Its explanatory comment — which describes
  the assertion as making a `[...].sort()` observable — must be rewritten: there
  is no such sort (Task 4 Step 3 renamed the variable that implied it). It now
  asserts that the join's natural order is the REVERSE of the scan's, which is
  what makes the mutation reproducible.
- The hook currently intercepts `class.updateMany` and delays after
  `casCalls === 1`. Re-point it to `$queryRaw`, keyed on the bound `teacherId`
  the pre-lock carries — this file's house rule is keying hooks on the query's
  own arguments, never on call sequence:

```ts
    const racing = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          // Keyed on `teacherId`, which is what `deleteTeacherAccount`'s
          // ordered pre-lock binds since #237 — not on call order, and not on
          // the cancel CAS the previous version hooked. That hook fired at
          // `casCalls === 1`, in the window between two per-class locks; the
          // pre-lock closed that window, and a hook aimed at it now fires with
          // every lock already held. Verified during #237: with the old hook in
          // place, deleting `ORDER BY c.id` from the helper left this test
          // GREEN.
          //
          // Signals before the statement runs and holds, letting the student
          // erasure take its own ordered lock set first; this side then asks
          // for both rows at once and either queues behind it (ordered) or
          // cycles against it (unordered).
          if (Array.isArray(args.values) && args.values.includes(teacherId)) {
            preLockReached();
            await new Promise((r) => setTimeout(r, 300));
          }
          return query(args);
        },
      },
    }) as unknown as PrismaClient;
```

with the promise pair declared above it, following the file's existing
handshake pattern:

```ts
    let preLockReached!: () => void;
    const preLockReachedPromise = new Promise<void>((resolve) => {
      preLockReached = resolve;
    });
```

Keep the two `expect` assertions on the outcomes (`teacher-ok`, `student-ok`)
and the assertion that both classes were actually reached — that is what stops
a fixture which never contended from satisfying the test.

Update the test's own docblock to say what it now pins and how it is
constructed. Delete the `casCalls` counter if nothing else reads it.

- [ ] **Step 5: Run it, then prove it bites**

```bash
npx vitest run --project unit src/services/gdpr.test.ts
```
Expected: PASS, 23 tests.

Mutate `src/lib/db-locks.ts`: delete `ORDER BY c.id`. Re-run.

Expected: **FAIL** at the re-pointed test with `40P01 deadlock detected`.

Run it **5 times** under the mutation and report the count of failures. A race
reproduction that fails 3 times in 5 is not a guard; if it is not 5/5, say so
and report it rather than tuning the delay until one run goes red.

Restore, re-run, confirm PASS.

- [ ] **Step 6: If it cannot be made to bite, say so in the docblock**

Only if Step 5 does not reach 5/5 after the fixture flip. Do **not** leave a
green test that certifies nothing and do **not** delete it. Record in its
docblock what was tried, what the measured failure rate was, and that the
guarantee now rests on `db-locks-lock-order.test.ts` — the honesty precedent
`template-lock-order.test.ts` set when it lost its own bite. Report it as a
finding, not as a completed step.

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "fix: deleteTeacherAccount takes its Class locks in one ordered statement

Its lock order came from an orderBy on a read that held no locks, because
the per-class cancel CAS was what took them. Now one ordered pre-lock,
before the read. The read stays wide and the CAS stays: a class inserted
between the two is not held here, and scoping the read to the locked ids
would let it escape the erasure entirely.

Brings the shared 2s lock_timeout into a transaction that had none.

Re-points the reproduction this fold makes vacuous. Measured, not assumed:
with the old hook in place, deleting ORDER BY c.id from the helper left
gdpr.test.ts green — the hook fired at casCalls === 1, a window the
pre-lock closes. The fixture's waitlist rows are now seeded LOW-first so
the join's natural order opposes the scan's, which is the only thing that
still makes the mutation reproducible once one ORDER BY orders both sides."
```

---

### Task 9: Retire the prose census

**Files:**
- Modify: `docs/lock-order.md:56-115` (table + surrounding), `:145-170`
  (derivation check 2)
- Modify: `src/lib/db-locks.ts:169-188` (the register)
- Modify: `src/services/gdpr.ts:660-705` (the timeout arithmetic)
- Modify: `src/services/template-lock-order.test.ts` (header docblock + `:363-368`)

**Every claim below has more than one home. Fix each location and verdict each
location separately** — a finding that names three files gets three verdicts,
not one. Derive the sweep from this task's own diff, not from a keyword.

- [ ] **Step 1: Collapse `docs/lock-order.md`'s within-`Class` table**

Replace the five-row table and the paragraphs that maintain it with a statement
of the invariant plus the one exception:

```markdown
**The rule: ascending by `id`, taken by `lockClassRowsOrdered`
(`src/lib/db-locks.ts`).** Every site that locks more than one `Class` row goes
through it, and it is the only production `SELECT … FOR UPDATE OF c` in `src/`
— so the check is a grep, not a list:

    grep -rn 'FOR UPDATE OF' --include="*.ts" src/ | grep -v '\.test\.ts'

Anything that returns beyond `db-locks.ts` is a site that has left the
convention, and that is the whole enforcement. The helper owns the order, the
`FOR UPDATE OF c` lock mode, the shared 2s bound and the dedupe; a sixth site
inherits all four by calling it.

**Before #237 this section was a five-row table**, and it was corrected about
its own membership four times — the last of them by the round that filed the
issue, which added `deleteStudentAccount`'s statement to the table and not to
the derivation below it. The table is gone rather than corrected a fifth time.

**One exception survives, and it is about a predicate rather than an order.**
`archiveOrUnarchiveTemplate`'s (`class-template-lifecycle.ts`) call covers
`date > today`, so a same-day instance rescheduled into the future by
`updateClass` (`class-lifecycle.ts`) — a bare `db.class.updateMany` holding
neither the template lock nor any `Class` lock — between that call and the
`deleteMany` is deleted without ever having been held. The AB-BA cycle against
`deleteStudentAccount` can still form through that window. It is narrow (it
needs a concurrent reschedule *and* an erasure of a student waitlisted across
both classes, timed into the same gap), it is measured rather than theorised,
and it is no worse than the pre-#180 state, which had no ordering at all — but
it is not closed. Widening the call past `today` would lock history for no
gain, and #86/#112 require the delete's live predicate re-evaluation regardless.
`syncTemplateInstances` does not share it: its write set is
`id: { in: lockedIds }`, a structural subset of what its own call returned.

`syncTemplateInstances`'s predicate carries no `status`/`settingsLocked`
narrowing beyond `templateId`/`teacherId`/`date >` the current UTC calendar
date, so it briefly locks every future instance of the template — including
ones already `settingsLocked` by a registration, which its own writes will
never touch. That is the safe direction for lock ordering, but it means a
booking on one of those instances can contend with a template edit, where
before #180 it could not — **for the rest of the edit transaction, not merely
for the statement**. `SELECT … FOR UPDATE` holds until the transaction ends, so
in production the exposure is bounded by `updateClassTemplate`'s
`{ timeout: 15_000 }`, not by how long the `SELECT` itself takes.

See "The slot key is a wait edge" below before assuming `id` is the only thing
that orders two `Class` rows: since #196 a unique index on
`(teacherId, date, startTime)` makes plain INSERTs take part too, which is a
case a site enumeration is built not to find.
```

- [ ] **Step 2: Fix the derivation subsection's arithmetic**

`docs/lock-order.md`'s check 2 says "**8** in total … **5** are single-id …
**The other 3 are multi-row**". Re-derived on 2026-08-16: **9** statements, **5**
single-id and **4** multi-row — `deleteStudentAccount`'s was missing. After this
branch the shape changes again, so replace the count with what the branch makes
checkable:

```markdown
2. `'"Class"'` — the raw statements. **Do not carry a number here; grep it.**
   An earlier version of this check said "8 in total … the other 3 are
   multi-row"; re-derivation on 2026-08-16 found 9 and 4, because
   `deleteStudentAccount`'s ordered statement had been added to the table above
   without being added here. That is the fourth time this document was wrong
   about its own list, and #237 is the response. What holds now, and is
   checkable rather than remembered: **every multi-row lock is
   `lockClassRowsOrdered` (`db-locks.ts`), and it is the only production
   `FOR UPDATE OF c` in `src/`.** The single-id `FOR UPDATE`s remain plural and
   inline — four in `waitlist.ts` (`addToWaitlist`, `promoteNext`, `claimSpot`,
   `removeFromWaitlist` via `lockClassRow`), one in `POST /api/registrations`,
   plus `lockClassRow`'s own body — and they carry no ordering obligation
   individually, which is why they were never the subject here. Their unbounded
   wait is #104's subject;
```

Also correct the sentence in that subsection's closing paragraph that says
"That leaves the five above for lock-ordering *within* `Class`" — there is no
list above it any more.

- [ ] **Step 3: Fix `db-locks.ts`'s register**

`src/lib/db-locks.ts:179-188` names `lockClassRow`'s call sites as
`completeClass`, `removeFromWaitlist`, `deleteStudentAccount` and
`autoCancelClasses`. Re-derived: `gdpr.ts` no longer calls it at all, and the
real five are `autoTransitionToInProgress` (`class-transitions.ts`),
`autoCancelClasses` (same file), `completeClass` (`class-lifecycle.ts`),
`removeFromWaitlist` and `handleSpotFreed` (both `waitlist.ts`).

Replace the enumeration with the correction and the reason it survived:

```
 * Its callers are not listed here any more, and the reason is the point of
 * #237. They were, and the list went stale the way every list in this
 * codebase's lock documentation has: `deleteStudentAccount` was named as a
 * caller long after #216/#182 replaced its `lockClassRow` loop with a single
 * ordered statement, and `autoTransitionToInProgress` was never named at all.
 * The COUNT stayed five throughout — five names, five call sites — so nothing
 * that counted could catch it; only re-deriving the names could. Grep for
 * `lockClassRow(` when you need them.
```

Keep the `#104` paragraph (`:169-178`) — it is about the inline sites and is
still accurate — and add `lockClassRowsOrdered` to the `adopt`/`skip` register
at the top of the module (`:17-66`).

- [ ] **Step 4: Fix `gdpr.ts`'s timeout arithmetic**

`src/services/gdpr.ts:665` prices `waitingCount * 2_000` as covering "the lock
loop's own worst case: `lockClassRow`'s `SET LOCAL lock_timeout` bounds each
class's `FOR UPDATE` wait to 2s, and N contended classes can burn that in
sequence." There is no lock loop — one statement takes one 2s bound. `:700`
likewise places the reorder loop "after the lock loop above".

Rewrite both so the formula's justification matches what the code does: the
term now covers the reorder loop's per-class cost (`reorderWaitingEntries`'
`findMany` plus up to M `UPDATE`s per class, each under the same 2s bound), not
a lock loop's wait. State that the formula is now **over-generous rather than
wrong**, and that resizing it is deliberately not this branch's change.

- [ ] **Step 5: Fix `template-lock-order.test.ts`, both claims**

Two separate stale claims in this file — verdict each:

1. **The header docblock** says "`deleteStudentAccount` (`gdpr.ts`) takes them
   ASCENDING by id — `[...ids].sort()` in JS, before the `lockClassRow` loop."
   Neither the sort nor the loop exists. Rewrite to describe the current
   mechanism.
2. **`:363-368`** says the erasure's ordering "is now guarded … by the shared
   idiom and by `docs/lock-order.md`'s within-`Class` table — rather than by a
   reproduction. That is a real reduction in coverage." Measured on 2026-08-16:
   deleting the clause failed `gdpr.test.ts:1344` with `40P01`, 5 runs out of 5.
   It was guarded by a reproduction the whole time, in another file, which
   `gdpr.ts:485-494` already named. Correct it to say so, and point at
   `db-locks-lock-order.test.ts` as the general guard this file's three tests
   are now specific instances of.

The claim in item 2 also appears in **the GitHub issue** — post a correction
comment there in Task 10 rather than here.

- [ ] **Step 6: Reconcile the sweep against this task's diff**

```bash
git diff --stat
grep -rn "sortedWaitingClassIds" src/                     # expect: nothing
grep -rn "lock loop" src/services/gdpr.ts                  # expect: nothing, or a corrected use
grep -rn "FOR UPDATE OF" --include="*.ts" src/ | grep -v '\.test\.ts' | grep -v '^\s*\*'
  # expect: exactly one production statement, in src/lib/db-locks.ts
```

List the files this task changed, list the files it was *supposed* to change
(the four in **Files** above), and reconcile the two in the report. A keyword
sweep scoped to one claim cannot see another claim's twin.

- [ ] **Step 7: Commit**

```bash
git add docs/lock-order.md src/lib/db-locks.ts src/services/gdpr.ts src/services/template-lock-order.test.ts
git commit -m "docs: retire the census that went stale four times

lock-order.md's within-Class table becomes a grep — every multi-row lock
is lockClassRowsOrdered, and it is the only production FOR UPDATE OF c in
src/. The archive's date > today exception survives, because it is about a
predicate rather than an order and this branch does not close it.

Its derivation subsection said 8 raw statements and 3 multi-row.
Re-derived: 9 and 4. deleteStudentAccount's statement had been added to
the table above and not to the derivation below it, in the round that
filed the issue asking for the list to stop being prose.

db-locks.ts's register named deleteStudentAccount as a lockClassRow caller
after it stopped being one, and never named autoTransitionToInProgress.
The count stayed five while the membership changed, so nothing that
counted could catch it.

gdpr.ts priced its transaction timeout as covering a lock loop that no
longer exists. template-lock-order.test.ts described a JS sort that no
longer exists, and called the erasure's ordering unguarded by any
reproduction — measured 2026-08-16, deleting the clause fails
gdpr.test.ts with 40P01, five runs out of five."
```

---

### Task 10: Whole-branch verification

**Files:** none modified unless verification finds something.

- [ ] **Step 1: Run the full suite**

The app must already be running on :3000 (the user runs it — **do not start or
restart it**). The `integration` project talks to it over HTTP; without it you
get a wall of `ECONNREFUSED`.

```bash
npm run verify
```

Expected: PASS — typecheck, lint, and all three vitest projects.

Record **files and tests per project**, with totals that reconcile
(`a + b + c = total`). Do not inherit the baseline in this plan; measure.

- [ ] **Step 2: Assert the acceptance criterion mechanically**

```bash
grep -rn "FOR UPDATE OF" --include="*.ts" src/ | grep -v '\.test\.ts' | grep -v '^\S*:\s*[*/]'
```

Expected: exactly one line, in `src/lib/db-locks.ts`.

```bash
grep -rn 'lockClassRowsOrdered(' --include="*.ts" src/ | grep -v '\.test\.ts'
```

Expected: the definition plus five call sites — `gdpr.ts` twice,
`waitlist.ts`, `template-sync.ts`, `class-template-lifecycle.ts`. Name them in
the report rather than counting them.

- [ ] **Step 3: Re-run every mutation this branch claims**

The branch's guarantees rest on these; re-run them against the *final* state,
because a mutation proved at task 2 says nothing about the code at task 9.

| Mutation | Expected failure |
|---|---|
| Delete `ORDER BY c.id` from the helper | `db-locks-lock-order.test.ts` **and** `gdpr.test.ts:1344`, both `40P01` |
| `ORDER BY c.id` → `ORDER BY c.id DESC` | `db-locks-lock-order.test.ts`, `40P01` |
| Helper param → `Prisma.TransactionClient` | `tsc --noEmit`, unused `@ts-expect-error` |
| `CANCELLABLE_STATUSES` drops `'in_progress'` | `gdpr.test.ts` |

Restore and re-verify after each. Report any that did not fail — a mutation
that survives is a finding, not a step to skip.

- [ ] **Step 4: Report, do not commit**

Nothing to commit unless Step 1-3 found a defect. Hand back, for the PR body:

- files and tests per project, with the arithmetic that reconciles them;
- the `integration` files this branch touched, **by path** (expected: none —
  say so explicitly rather than leaving it unstated, since a green `verify`
  runs all of them either way and the PR body must not imply otherwise);
- which mutations were re-run and what each produced;
- which inherited claims were checked and which held — in particular that the
  issue's "deleting that clause leaves all three green" **held**, and that the
  conclusion drawn from it did not;
- what the branch does **not** do, written as "**#N is unaffected**" and never
  as "does not close #N" — GitHub's parser matches the keyword and ignores the
  negation in front of it. The four: the archive's `date > today` residual,
  #104, #238, and resizing `deleteTeacherAccount`'s transaction budget.
