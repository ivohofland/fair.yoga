# Queue Close on Start, and Locking the Two Remaining Sweeps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No `waiting` waitlist row survives its class leaving `open`, at all three
`in_progress` exits; and the two sweeps that still decide from an unlocked snapshot
decide under the class row lock instead.

**Architecture:** One named helper (`closeQueueOnStart`) called from three sites, each
already inside — or newly given — a transaction. `autoTransitionToInProgress` is
rewritten to mirror `autoCancelClasses` (lock → re-read → CAS). `autoCompleteClasses`
gets no transaction of its own; its timing decision moves *into* `completeClass`, which
already holds the lock and already re-reads the row. The attendance PUT is scoped by
source status rather than locked.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma + PostgreSQL,
Vitest (three projects: `unit`, `components`, `integration`).

**Spec:** `docs/superpowers/specs/2026-08-15-queue-close-and-sweep-locks-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `noUncheckedIndexedAccess`
  is on — indexing an array yields `T | undefined`.
- **Test-first, with one stated exception.** Most tests here are **drivers**: write it,
  run it, see it fail *for the reason this plan predicts*, then implement. A test that
  fails for a different reason proves nothing about the fix — stop and report.

  Some tests here are **guards**, and a guard is expected to **PASS before the
  change**. A guard asserts that the implementation does not over-reach or regress
  something that already works — `transitionClass` not expiring a queue on
  `draft → open` (Task 3), `completeClass` still finishing early without
  `requireEndedBy` (Task 5), attendance still writable on a `completed` class
  (Task 6), the cancel notice naming the current class (Task 7). **A guard is proved
  by its mutation, not by failing first.** Each task says which of its tests are
  which; report both, and never "fix" a guard to make it fail first.
- **Every guard gets a mutation proof.** Break it, record the **exact** failure text in
  the task report, restore, re-verify. A guard that cannot fail certifies nothing.
- **Mutation values must be ones the code under test cannot produce.** For date
  mutations, move the class a **week**, not minutes — a nudge inside the window the
  sweep already accepts proves nothing.
- **Never start or restart the dev server on :3000.** The user runs it; the
  `integration` project talks to it over HTTP.
- **Test fixtures: hoist the expensive ones, sweep the cheap ones.** This is the
  codebase's actual rule, and it is narrower than "hoist everything". Teachers, rooms,
  teacherRooms and students are created once in `beforeAll` — they are shared and
  costly. Per-test **classes** are created inline, because tests need different class
  states and hoisting them would make tests share mutable rows.

  What makes inline classes safe is the block's `afterAll` being a **catch-all**:
  `class-transitions.test.ts:115-116` sweeps `class.deleteMany({ where: { teacherId } })`
  and `teacherRoom.deleteMany({ where: { teacherId } })`, so a class from a test that
  died before its own cleanup is still removed. A block whose `afterAll` deletes by an
  explicit id list instead — as `waitlist.test.ts:302-315` did — leaks the class and
  then dies on an FK violation at `teacherRoom.delete`.

  **So: before adding an inline-class test to an existing block, check that block's
  `afterAll` sweeps by `teacherId`. If it deletes by an id list, convert it first.**
  The mutation protocol guarantees failing runs, so this is not hypothetical — it fired
  on Task 1.

  **Get the mechanism right — an earlier version of this constraint did not, and the
  wrong version reached three comments in two test files.** The row that blocks
  teardown is the surviving **`Class`**, and what it blocks is
  `teacherRoom.deleteMany` / `room.delete`, because `Class.teacherRoomId` is a plain
  FK. It is **not** the `WaitlistEntry`: `WaitlistEntry.class` is
  `onDelete: Cascade` (`prisma/schema.prisma:575`), so waitlist rows disappear with
  their class and can never block a class delete. A `waitlistEntry.deleteMany` in an
  `afterAll` is harmless and mildly defensive, but it is **not** what makes the
  teardown FK-safe, and any comment claiming it is should be corrected (Task 9).
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing
  parentheses: `"src/app/(student)/bookings/page.tsx"`.
- **Commit per task.** The PR is rebase-merged; the commit-per-task history is the record.
- **Do not write `close #N` / `fixes #N` / `resolves #N` in any commit message** unless
  you intend GitHub to close that issue. To disclaim scope, write "**#N is unaffected**".
- **`@/lib/log` is pino and server-only.** Safe in every file this plan touches
  (`waitlist.ts` already imports it; `class-lifecycle.ts` does not need it).
- **The status value is `expired`**, not `removed`. This was decided in the spec §2.1
  with reasons; do not substitute.

**Measured baseline, 2026-08-15, `npm run verify` green:**

| Project | Files | Tests |
|---|---:|---:|
| unit | 52 | 744 |
| components | 37 | 202 |
| integration | 28 | 397 |
| **total** | **117** | **1343** |

`52 + 37 + 28 = 117` · `744 + 202 + 397 = 1343`. **Measure the after-figure; do not
predict it** — this branch's own review will add tests no prediction can know about.

---

## File Structure

**Created:** none. Every change lands in an existing file.

| File | Responsibility after this branch |
|---|---|
| `src/services/waitlist.ts` | gains `closeQueueOnStart` — the single writer of `expired` |
| `src/services/class-lifecycle.ts` | `transitionClass` transacts + closes; `completeClass` closes on the open-bump and gains `requireEndedBy` |
| `src/services/class-transitions.ts` | `autoTransitionToInProgress` decides under the lock; `autoCompleteClasses` delegates timing |
| `src/app/api/registrations/[id]/route.ts` | the PUT is scoped by source status and rejects a cancelled class |
| `src/app/api/classes/[id]/transition/route.ts` | the cancel notice is built from an in-transaction re-read |
| `docs/lock-order.md` | both sweeps become documented conforming sites |

**Test homes:**

| Behaviour | Test file | Project |
|---|---|---|
| `closeQueueOnStart` | `src/services/waitlist.test.ts` | unit |
| `completeClass`, `transitionClass` | `src/services/class-lifecycle.test.ts` | unit |
| both sweeps | `src/services/class-transitions.test.ts` | unit |
| the transition route | `tests/integration/classes-api.test.ts` | integration |
| the attendance PUT | `tests/integration/registrations-api.test.ts` | integration |
| the `expired` display fixture | `tests/integration/waitlist-display.test.ts` | integration |

---

## Task Order — what is load-bearing

- **Task 1 before everything.** Nothing can call the helper before it exists.
- **Task 8 after Task 1.** The `expired` fixture row pins display predicates against a
  value that must actually be reachable in production first.
- **Task 9 last, and it must reconcile against the branch's diff.** Listing the files
  the branch changed and comparing them to the files it was *supposed* to change is the
  procedure; a keyword grep scoped to one claim cannot see another claim's twin.
- Tasks 2–7 are independent of one another. The order below is narrative, not required.

---

## Task 1: `closeQueueOnStart`

**Files:**
- Modify: `src/services/waitlist.ts` (add at end of file, after `reorderWaitingEntries`)
- Test: `src/services/waitlist.test.ts`

**Interfaces:**
- Consumes: `TransactionClientOnly` from `@/lib/db-locks` — **already imported** at
  `waitlist.ts:14`. Do not add a second import.
- Produces: `closeQueueOnStart(tx: TransactionClientOnly, classId: string): Promise<number>`
  — used by Tasks 2, 3 and 4.

- [ ] **Step 1: Write the failing test**

Append to `src/services/waitlist.test.ts`. It needs a teacher, room, teacherRoom,
class and two students; follow the fixture pattern already in that file (`beforeAll`
creating fixtures, `afterAll` deleting them). Add this to the existing DB describe block
that already has those fixtures, reusing its `makeClass`-equivalent helper rather than
building a new one.

```ts
describe('closeQueueOnStart', () => {
  it('closes every waiting row to expired and leaves other statuses alone', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    await prisma.waitlistEntry.createMany({
      data: [
        { classId: cls.id, studentId, position: 1, status: 'waiting' },
        { classId: cls.id, studentId: secondStudentId, position: 2, status: 'removed' },
        { classId: cls.id, studentId: waiterStudentId, position: 3, status: 'promoted' },
      ],
    });

    const closed = await prisma.$transaction((tx) => closeQueueOnStart(tx, cls.id));
    expect(closed).toBe(1);

    const rows = await prisma.waitlistEntry.findMany({
      where: { classId: cls.id },
      orderBy: { position: 'asc' },
      select: { position: true, status: true },
    });
    // Three distinct statuses, so no off-by-one predicate reproduces this.
    // `removed` and `promoted` are BOTH present because a helper that wrote
    // every row, or that keyed on `not: 'expired'`, would pass against either
    // one alone.
    expect(rows).toEqual([
      { position: 1, status: 'expired' },
      { position: 2, status: 'removed' },
      { position: 3, status: 'promoted' },
    ]);

    await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('returns 0 and writes nothing when there is no queue', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    const closed = await prisma.$transaction((tx) => closeQueueOnStart(tx, cls.id));
    expect(closed).toBe(0);
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('leaves another class queue untouched', async () => {
    const mine = await makeClass({ status: 'in_progress' });
    const theirs = await makeClass({ status: 'open' });
    await prisma.waitlistEntry.createMany({
      data: [
        { classId: mine.id, studentId, position: 1, status: 'waiting' },
        { classId: theirs.id, studentId, position: 1, status: 'waiting' },
      ],
    });

    await prisma.$transaction((tx) => closeQueueOnStart(tx, mine.id));

    const other = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: theirs.id },
    });
    expect(other.status).toBe('waiting');

    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: [mine.id, theirs.id] } } });
    await prisma.class.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
  });
});
```

Add `closeQueueOnStart` to the import list at the top of `waitlist.test.ts`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run --project unit src/services/waitlist.test.ts -t closeQueueOnStart`

Expected: FAIL. The import does not resolve — the message names
`closeQueueOnStart` as not exported from `./waitlist`. **Record the exact text.**
If it fails for any other reason, stop and report: a test that fails for the wrong
reason proves nothing about the fix.

- [ ] **Step 3: Implement**

Append to `src/services/waitlist.ts`:

```ts
/**
 * Closes a class's queue because the class has STARTED, not because it was
 * cancelled or left.
 *
 * `expired`, and it is the only writer of that value in the codebase. The three
 * cancel paths write `removed`, matching `removeFromWaitlist` — a student who
 * left. This one means the opposite: a student who never got in. The
 * distinction is not decorative. `exportStudentData` (`gdpr.ts`) publishes
 * `WaitlistEntry.status` verbatim and, unlike the registrations half of the
 * same export, does NOT select the class's status — so `removed` here would
 * tell a subject-access request that the student withdrew, which is a
 * different and equally wrong story from the one the data supports.
 *
 * No reorder. `reorderWaitingEntries` renumbers only `waiting` rows, so closed
 * rows keep stale positions by design (#183); closing an entire queue at once
 * leaves nothing to renumber, which is why the two cancel paths issue their
 * `updateMany` without one either.
 *
 * No notification. #112's promise was about a class ceasing to be OFFERED. A
 * class that ran is not that, and "it happened without you" is noise to
 * someone who was never promised a seat.
 *
 * No read-before-write, unlike the cancel paths: they read first because they
 * need a recipient list, and this one has no recipients. The returned count is
 * the whole result.
 *
 * `TransactionClientOnly` rather than this module's `PrismaTransactionClient`
 * alias, deliberately: running this outside a transaction — where the status
 * flip and the queue close could commit separately — IS the defect, so the
 * type refuses a bare client rather than trusting the caller.
 *
 * The caller must have already taken the `Class` row lock, or written the
 * status via a CAS `UPDATE` that took it. Every other `WaitlistEntry` writer
 * conflicts on that row, so this statement cannot interleave with one.
 */
export async function closeQueueOnStart(
  tx: TransactionClientOnly,
  classId: string,
): Promise<number> {
  const { count } = await tx.waitlistEntry.updateMany({
    where: { classId, status: 'waiting' },
    data: { status: 'expired' },
  });
  return count;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run --project unit src/services/waitlist.test.ts -t closeQueueOnStart`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation proof**

Change `status: 'waiting'` in the `where` to `status: { not: 'expired' }`, re-run.
Expected: the first test FAILS, showing `removed` and `promoted` rewritten to
`expired`. **Record the exact assertion diff.** Restore and re-verify PASS.

Then change `data: { status: 'expired' }` to `data: { status: 'removed' }`, re-run.
Expected: the first test FAILS on position 1. **Record the text.** Restore, re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts
git commit -m "feat: closeQueueOnStart, the only writer of expired

A queue closed because its class STARTED is a different fact from one
closed because the class was cancelled or the student left. The Article 15
export publishes WaitlistEntry.status verbatim and does not select the
class's status for waitlist entries, so removed would report a withdrawal
that never happened.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `completeClass` closes the queue on its open-bump

**Files:**
- Modify: `src/services/class-lifecycle.ts:208-211`
- Test: `src/services/class-lifecycle.test.ts`

**Interfaces:**
- Consumes: `closeQueueOnStart` from Task 1.
- Produces: nothing new.

**Context the implementer needs:** `completeClass` opens `db.$transaction`, calls
`lockClassRow(tx, classId)` *before* its read, then re-reads the class. A teacher
completing an `open` class directly hits the inline bump at `:208-211` — `open →
in_progress` — and that is the third of #216's three exits. The `else` branch needs
nothing: a class already `in_progress` had its queue closed on the way there, and
`addToWaitlist` refuses a non-`open` class, so no new `waiting` row can appear.
`VALID_TRANSITIONS` has no path back to `open`.

- [ ] **Step 1: Write the failing test**

Add to the `completeClass` describe block in `src/services/class-lifecycle.test.ts`:

```ts
it('closes the waitlist when a teacher completes an open class directly', async () => {
  const cls = await makeClass({ status: 'open' });
  await prisma.registration.create({
    data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
  });
  const entry = await prisma.waitlistEntry.create({
    data: { classId: cls.id, studentId: secondStudentId, position: 1, status: 'waiting' },
  });

  const result = await completeClass(prisma, cls.id);
  expect(result.ok).toBe(true);

  const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
  // `expired`, not `removed`: this student never got in, they did not leave.
  expect(after.status).toBe('expired');
});
```

Use the fixture ids and `makeClass` helper already present in that describe block; if
the block lacks a second student, hoist one into its `beforeAll` alongside the existing
fixtures — **not** inline in the test, because a fixture cleaned up only at its own
test's tail leaks on every failing run, and this suite's mutation protocol guarantees
failing runs.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts -t "completes an open class directly"`
Expected: FAIL — `expected 'waiting' to be 'expired'`. **Record the exact text.**

- [ ] **Step 3: Implement**

In `src/services/class-lifecycle.ts`, import the helper alongside the existing service
imports:

```ts
import { closeQueueOnStart } from './waitlist';
```

Then, at `:208-211`:

```ts
    // If open, transition to in_progress first (teacher completing directly)
    if (cls.status === 'open') {
      const toInProgress = validateTransition('open', 'in_progress');
      if (!toInProgress.ok) return toInProgress;
      await tx.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
      // #216, third of the three `open -> in_progress` exits. The other two go
      // through `transitionClass` and `autoTransitionToInProgress`; this one
      // does not, so it needs its own call. Inside the lock this function
      // already holds, so it is atomic with the status flip above.
      await closeQueueOnStart(tx, classId);
    } else {
```

**Check for an import cycle** before committing: `waitlist.ts` imports from
`./notifications`, `./link-consent`, `./capacity` — not from `./class-lifecycle`. If
`tsc` reports a cycle, stop and report rather than working around it.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Mutation proof**

Delete the `await closeQueueOnStart(tx, classId);` line. Re-run.
Expected: FAIL — `expected 'waiting' to be 'expired'`. **Record the exact text.**
Restore and re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
git commit -m "fix: completing an open class directly closes its queue

Third of the three open -> in_progress exits, and the only one that does
not go through transitionClass.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `transitionClass` transacts, and closes the queue on `in_progress`

**Files:**
- Modify: `src/services/class-lifecycle.ts:124-148`
- Test: `src/services/class-lifecycle.test.ts`, `tests/integration/classes-api.test.ts`

**Interfaces:**
- Consumes: `closeQueueOnStart` (Task 1), already imported by Task 2.
- Produces: `transitionClass`'s signature is **unchanged** — same parameters, same
  `TransitionDbResult`. Task 4 will stop calling it; nothing else changes.

**Context:** `transitionClass` is currently a bare `updateMany` CAS followed, on
failure, by two diagnostic reads. It has exactly two production callers: this branch's
Task 4 removes one, and `POST /api/classes/[id]/transition:109` is the other.
`transitionClassSchema` (`schemas.ts:362-364`) accepts `in_progress`, so that route's
generic branch is reachable rather than theoretical.

**The transaction must wrap only the two writes.** The diagnostic reads decide nothing
that gets persisted and must stay outside it.

- [ ] **Step 1: Write the failing tests**

Unit, in `src/services/class-lifecycle.test.ts`'s `transitionClass (DB)` block:

```ts
it('closes the waitlist when it moves a class to in_progress', async () => {
  const cls = await makeClass({ status: 'open' });
  const entry = await prisma.waitlistEntry.create({
    data: { classId: cls.id, studentId, position: 1, status: 'waiting' },
  });

  const result = await transitionClass(prisma, cls.id, 'in_progress');
  expect(result.ok).toBe(true);

  const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
  expect(after.status).toBe('expired');
});

it('leaves the waitlist alone when it moves a class to open', async () => {
  // The close is predicated on the TARGET, not on "any successful CAS".
  // Without that predicate this row would be expired by a draft -> open
  // publish, which is the opposite of what the queue means.
  const cls = await makeClass({ status: 'draft' });
  const entry = await prisma.waitlistEntry.create({
    data: { classId: cls.id, studentId, position: 1, status: 'waiting' },
  });

  const result = await transitionClass(prisma, cls.id, 'open');
  expect(result.ok).toBe(true);

  const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
  expect(after.status).toBe('waiting');
});
```

Integration, in `tests/integration/classes-api.test.ts`'s
`POST /api/classes/[id]/transition` block — this covers the *route*, which the unit test
does not reach. That block already has a `transition(token, id, body)` helper at `:312`;
the file's fixtures include `ownerToken`, `ownerId`, `teacherRoomId` and
`waitStudentId` (a student created for the #112 notice tests). Create a **fresh** class
rather than reusing `noticeClassId` or `classId`, both of which other tests in the file
assert against:

```ts
it('closes the waitlist when a teacher moves a class to in_progress', async () => {
  const cls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Queue Close',
      date: new Date('2099-01-01'),
      startTime: '10:00',
      durationMinutes: 60,
      roomCost: 30,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 4,
      status: 'open',
    },
  });
  const entry = await prisma.waitlistEntry.create({
    data: { classId: cls.id, studentId: waitStudentId, position: 1, status: 'waiting' },
  });

  const res = await transition(ownerToken, cls.id, { status: 'in_progress' });
  expect(res.status).toBe(200);

  const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
  expect(after.status).toBe('expired');

  await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
  await prisma.class.delete({ where: { id: cls.id } });
});
```

Confirm the `date`/`startTime` shape against the file's own class-creation sites before
running — if this suite has a `makeClass`-style helper by the time you get here, use it
instead of inlining the fields.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts -t "moves a class to in_progress"`
Expected: FAIL — `expected 'waiting' to be 'expired'`. **Record the exact text.**

The second unit test ("leaves the waitlist alone") is expected to **PASS** before the
change — it is a guard against over-reach, not a driver. Say so in the report.

- [ ] **Step 3: Implement**

Replace the body of `transitionClass` (`class-lifecycle.ts:129-147`) with:

```ts
  // The CAS and the queue close in one transaction; the diagnostic reads below
  // stay outside it, because they decide nothing that gets persisted and would
  // only hold the transaction open on the failure path.
  const moved = await db.$transaction(async (tx) => {
    const updated = await tx.class.updateMany({
      where: { id: classId, status: { in: sourceStatesFor(targetStatus) } },
      data: { status: targetStatus },
    });
    if (updated.count !== 1) return false;
    // #216. Predicated on the TARGET: `draft -> open` must not expire a queue,
    // and `-> cancelled` never reaches here (the route intercepts it, and no
    // other caller passes it).
    if (targetStatus === 'in_progress') await closeQueueOnStart(tx, classId);
    return true;
  });
  if (moved) return { ok: true, newStatus: targetStatus };

  // Nothing was written, so this read decides nothing that gets persisted —
  // it only tells the caller which refusal happened, and the route maps both
  // to a 409.
  const cls = await db.class.findUnique({ where: { id: classId }, select: { status: true } });
  if (!cls) return { ok: false, error: `Class not found: ${classId}` };

  const validation = validateTransition(cls.status, targetStatus);
  if (!validation.ok) return validation;

  // The CAS matched nothing, yet the status now permits the move: the row
  // changed twice while we were deciding. Refuse rather than retry — the
  // caller's decision was made against a world that no longer exists.
  return { ok: false, error: `Concurrent modification of class ${classId}` };
```

**Extend the docblock rather than rewriting it.** Its existing argument — that no
`FOR UPDATE` is needed because status is the only input to the decision — **still
holds** and must be preserved. Add a paragraph:

```
 * Since #216 this also closes the class's waitlist when the target is
 * `in_progress`, which is why the CAS now sits in a transaction. That does not
 * weaken the no-lock argument above: the close's own predicate (`classId`,
 * `status: 'waiting'`) is re-evaluated by Postgres at execution time, and the
 * CAS `UPDATE` has already taken the `Class` row lock that every
 * `WaitlistEntry` writer conflicts on — so a concurrent join or promotion is
 * either committed before this transaction's CAS or blocked behind it. This is
 * the same shape the manual-cancel branch of
 * `POST /api/classes/[id]/transition` has used since #112.
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts`
Then: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: PASS, both files.

- [ ] **Step 5: Mutation proof — two of them**

(a) Delete the `if (targetStatus === 'in_progress')` line and its call. Re-run the unit
file. Expected: the `in_progress` test FAILS. **Record the text.** Restore.

(b) Remove the `targetStatus === 'in_progress'` condition but keep the call (i.e. close
on every successful CAS). Re-run. Expected: the **`draft -> open`** test FAILS with
`expected 'expired' to be 'waiting'`. **Record the text.** Restore and re-verify both.

Mutation (b) is the one that matters: (a) proves the close happens, (b) proves it
happens *only where it should*. A guard proved by one mutation alone is half-proved.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts tests/integration/classes-api.test.ts
git commit -m "fix: transitionClass closes the queue when it starts a class

Covers the manual route's generic branch. The CAS moves into a transaction
so the two writes commit together; the diagnostic reads stay outside it.
The no-FOR-UPDATE argument in the docblock is unchanged and still holds.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `autoTransitionToInProgress` decides under the lock

**Files:**
- Modify: `src/services/class-transitions.ts:53-88`
- Test: `src/services/class-transitions.test.ts`

**Interfaces:**
- Consumes: `closeQueueOnStart` (Task 1), `lockClassRow` from `@/lib/db-locks`
  (**already imported** at `class-transitions.ts:16`).
- Produces: `autoTransitionToInProgress(db, now?)` — signature unchanged, still returns
  the number transitioned.

**Context — this is #182's acceptance 1, and it closes #216's first exit at the same
time.** Today the sweep decides *entirely* from the pre-transaction `findMany` at
`:62`. `date` and `startTime` are **not** in `ECONOMIC_FIELDS`, so a teacher can
reschedule an `open` class with registrations at any time, including mid-sweep. The
result is a class that has been moved being started against its old time.

`autoCancelClasses` (`:108-372`) is the worked example — read it before writing this.
It also **stops calling `transitionClass`**: it issues its own `tx.class.updateMany`
CAS. Follow that.

**The test hook is shape-keyed.** `class-transitions.test.ts` has a house rule, stated
at `:655-657`: hooks key on the shape of the query they mean to intercept.
`autoCancelClasses` reads a bare `status: 'open'`; **this sweep reads
`{ status: 'open', date: { lte: … } }`**. Key on the presence of `where.date` or the
hook will fire on the wrong sweep.

- [ ] **Step 1: Write the failing test**

Add to `src/services/class-transitions.test.ts`, modelled on the existing
'does not cancel a class rescheduled out of its window after the sweep read it'
(`:644-695`):

```ts
it('does not start a class rescheduled after the sweep read it', async () => {
  const cls = await makeClass({});

  let hookCalls = 0;
  const racing = prisma.$extends({
    query: {
      class: {
        async findMany({ args, query }) {
          // Shape-keyed, per this file's house rule. THIS sweep's read carries
          // a `date` filter; `autoCancelClasses`' carries a bare `status`.
          const where = args.where as { status?: unknown; date?: unknown } | undefined;
          if (where?.status !== 'open' || where.date === undefined) return query(args);

          hookCalls += 1;
          const rows = await query(args);
          // A WEEK later, not minutes: 16:00Z on July 20 is nowhere near the
          // new start on July 27, so no rounding or timezone offset can make
          // the stale decision accidentally correct.
          await prisma.class.update({
            where: { id: cls.id },
            data: { date: new Date('2026-07-27') },
          });
          return rows;
        },
      },
    },
  }) as unknown as PrismaClient;

  const transitioned = await autoTransitionToInProgress(racing, new Date('2026-07-20T16:00:00Z'));

  expect(hookCalls).toBe(1);
  expect(transitioned).toBe(0);

  const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
  expect(updated.status).toBe('open');

  await prisma.class.delete({ where: { id: cls.id } });
});

it('closes the waitlist when it starts a class', async () => {
  const cls = await makeClass({});
  const entry = await prisma.waitlistEntry.create({
    data: { classId: cls.id, studentId: waiterStudentId, position: 1, status: 'waiting' },
  });

  const transitioned = await autoTransitionToInProgress(prisma, new Date('2026-07-20T16:00:00Z'));
  expect(transitioned).toBeGreaterThanOrEqual(1);

  const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
  expect(after.status).toBe('expired');

  await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
  await prisma.class.delete({ where: { id: cls.id } });
});
```

`toBeGreaterThanOrEqual(1)` rather than `toBe(1)`: the sweep is unscoped and other
tests' classes may be in range. The waitlist row is the assertion that matters.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run --project unit src/services/class-transitions.test.ts -t "rescheduled after the sweep read it"`

Expected: **two** distinct failures across the two new tests —
`expected 1 to be 0` (the class was started against the stale time) and
`expected 'waiting' to be 'expired'`. **Record both exact texts.**

- [ ] **Step 3: Implement**

Replace the loop body in `autoTransitionToInProgress` (`class-transitions.ts:69-85`):

```ts
  for (const cls of openClasses) {
    // Per-class isolation: one bad class (corrupt timezone, failed
    // transition) must not halt the sweep for every other class.
    try {
      // Pre-filter from the snapshot, and an OPTIMISATION ONLY — the same
      // shape and the same reasoning as `autoCancelClasses` below. A stale
      // pre-filter can only DELAY a transition to the next 60-second tick,
      // never cause a wrong one, because nothing here transitions: it only
      // decides whether to open a transaction and look properly.
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      if (start > currentTime) continue;

      const didTransition = await db.$transaction(async (tx) => {
        // Locked before anything is read, not just before the write. This
        // decision reads more than a status — it reads `date` and `startTime`
        // and resolves them against the teacher's timezone — so per the rule
        // in `transitionClass`'s docblock this is a locking site, not a
        // CAS-only one. See `docs/lock-order.md`.
        await lockClassRow(tx, cls.id);

        // Re-read HERE and decide from THIS row. `date` and `startTime` are
        // NOT in `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so `settingsLocked`
        // does not freeze them and a teacher can reschedule an `open` class
        // with registrations at any time, including while this sweep is
        // mid-flight. Deciding from the outer `findMany` started a class
        // against a time it no longer had — and `in_progress` can only go to
        // `completed`, so the teacher cannot undo it in the app.
        const fresh = await tx.class.findUnique({
          where: { id: cls.id },
          select: {
            status: true,
            date: true,
            startTime: true,
            teacher: { select: { defaultTimezone: true } },
          },
        });
        // Deleted, or no longer open — a concurrent cancel, completion or
        // teacher action got here first. Not an error; the same outcome by a
        // different route, which is why this returns `false` rather than
        // logging, as `autoCancelClasses` does for the same case.
        if (!fresh || fresh.status !== 'open') return false;

        // Recomputed from `fresh`, not re-tested against the snapshot's
        // `start`. Re-testing the old instant is the defect wearing a lock.
        const freshStart = classStartInstant(
          fresh.date,
          fresh.startTime,
          fresh.teacher.defaultTimezone,
        );
        if (freshStart > currentTime) return false;

        // Redundant with the `fresh.status` check above, kept anyway for the
        // reason `autoCancelClasses` keeps its own: it costs nothing inside a
        // statement that has to run regardless, and it is the guard that
        // survives if someone later moves or drops the re-read.
        const updated = await tx.class.updateMany({
          where: { id: cls.id, status: 'open' },
          data: { status: 'in_progress' },
        });
        if (updated.count === 0) return false;

        // #216. First of the three `open -> in_progress` exits. Atomic with
        // the CAS above: a class that started with its queue left standing is
        // exactly the state this write exists to make unreachable.
        await closeQueueOnStart(tx, cls.id);
        return true;
      });

      if (didTransition) transitioned++;
    } catch (err) {
      log.error({ err, classId: cls.id }, 'transition to in_progress failed');
    }
  }
```

Add the import: `import { closeQueueOnStart } from './waitlist';`

**Two deliberate losses, both to be stated in the task report:**
1. The `transitionClass` call goes away, and with it `sourceStatesFor`'s derivation from
   the state machine. The CAS hardcodes `status: 'open'`, exactly as `autoCancelClasses`
   does.

   **Measured after the fact, because "accepted for consistency" understated it and a
   reader deserves the stronger claim: this loses no behaviour at all.**
   `VALID_TRANSITIONS` (`class-lifecycle.ts:33-39`) lists `in_progress` in exactly one
   state's transition list — `open`'s — so `sourceStatesFor('in_progress')` returns
   `['open']` and the hardcoded CAS is **literally equivalent** to the derived one.
   Nothing reachable was dropped. What is lost is only the *coupling*: if a future state
   ever gains `in_progress` as a target, this CAS will not follow the state machine and
   the sweep will silently skip that state. That is a real but different cost, and it is
   the one to write down.

   Two things were ruled out while checking this, both worth recording so nobody
   re-derives them. There is **no `full` status**: the Prisma enum
   (`schema.prisma:50-56`) and `VALID_TRANSITIONS` both carry exactly five states, and
   `full` is a *derived display* state computed as `activeCount >= maxStudents`
   (`src/components/ui/status-badge.tsx:55`, `src/app/(public)/[slug]/page.tsx:107`) —
   so a "full" class is stored as `open` and this sweep starts it correctly. CLAUDE.md's
   lifecycle line reads `draft → open → full → in_progress → …`, which is the
   user-visible sequence, not the stored one; it is imprecise rather than wrong, and it
   is **not** this branch's to fix. And `transitionClass` has no side effect beyond the
   CAS and its `in_progress` queue-close (`class-lifecycle.ts:143-153`), so no
   notification or downstream write was silently dropped with the call.

   **The same question applies to Task 5** and should be answered there rather than
   assumed: `sourceStatesFor('completed')` likewise resolves to a single state
   (`in_progress`), so check it explicitly instead of inheriting this paragraph.
2. The `log.error({ reason: result.error }, 'transition to in_progress rejected')` at
   `:79` goes away. A refusal is no longer an error — it is the ordinary "someone else
   got there first" outcome, which `autoCancelClasses` returns silently.

Check whether `transitionClass` is still imported by this file after the edit; if the
sweep was its only user here, **remove it from the import** or lint will fail on an
unused import. (`completeClass` is still used by `autoCompleteClasses`.)

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project unit src/services/class-transitions.test.ts`
Expected: PASS, whole file — including the three pre-existing
`autoTransitionToInProgress` tests at `:145`, `:157` and `:167`, which must still pass
unchanged. If `:167` ("early-local-morning classes that start before their UTC calendar
date") breaks, the `dateCeiling` pre-filter has been disturbed; report rather than
adjusting the test.

- [ ] **Step 5: Mutation proof — two of them**

(a) Change `freshStart` to reuse the snapshot's `start` (i.e. `if (start > currentTime)
return false;`). Re-run. Expected: 'does not start a class rescheduled after the sweep
read it' FAILS with `expected 1 to be 0`. **Record the text.** Restore.

(b) Delete `await closeQueueOnStart(tx, cls.id);`. Re-run. Expected: 'closes the
waitlist when it starts a class' FAILS. **Record the text.** Restore and re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-transitions.ts src/services/class-transitions.test.ts
git commit -m "fix: the start sweep decides under the lock, and closes the queue

Both halves of one transaction. The timing decision is recomputed from the
row read under lockClassRow, not re-tested against the snapshot -- date and
startTime are not economic fields, so a reschedule mid-sweep started a class
against a time it no longer had.

Drops the transitionClass call in favour of an inline CAS, matching
autoCancelClasses, and with it the rejected-transition log line: a refusal
here is the ordinary lost-race outcome, not an error.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `completeClass` owns the timing decision; `autoCompleteClasses` delegates it

**Files:**
- Modify: `src/services/class-lifecycle.ts:189-205` (signature + include + the check)
- Modify: `src/services/class-transitions.ts:395-409`
- Test: `src/services/class-transitions.test.ts`, `src/services/class-lifecycle.test.ts`

**Interfaces:**
- Produces: `completeClass(db: PrismaClient, classId: string, opts?: { requireEndedBy?: Date })`
  — **the third parameter is optional and defaults to `{}`**, so the two existing
  callers that omit it compile unchanged.

**Context — why this one does NOT get its own transaction.** `completeClass` already
takes `lockClassRow` *before* its read (`:199`) and already re-reads the class row. Only
the **timing** decision is unprotected, and it lives in the caller. Wrapping a second
lock around `completeClass` from the sweep would be redundant; the decision moves to
where the lock already is.

**Optional is the point, not a convenience:**

| Caller | Passes `requireEndedBy`? | Why |
|---|---|---|
| `autoCompleteClasses` (`class-transitions.ts:403`) | **yes**, `currentTime` | must not complete a class rescheduled later |
| `POST /api/classes/[id]/complete` (`:25`) | no | a teacher finishing early is legitimate |
| `deleteTeacherAccount` (`gdpr.ts:716`) | no | erasure completes in-flight classes regardless of clock |

- [ ] **Step 1: Write the failing tests**

In `src/services/class-transitions.test.ts`:

```ts
it('does not complete a class rescheduled after the sweep read it', async () => {
  const cls = await makeClass({ status: 'in_progress' });
  await prisma.registration.create({
    data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
  });

  let hookCalls = 0;
  const racing = prisma.$extends({
    query: {
      class: {
        async findMany({ args, query }) {
          // Shape-keyed: `autoCompleteClasses` is the only sweep reading
          // `status: 'in_progress'`.
          const where = args.where as { status?: unknown } | undefined;
          if (where?.status !== 'in_progress') return query(args);

          hookCalls += 1;
          const rows = await query(args);
          await prisma.class.update({
            where: { id: cls.id },
            data: { date: new Date('2026-07-27') },
          });
          return rows;
        },
      },
    },
  }) as unknown as PrismaClient;

  const completed = await autoCompleteClasses(racing, new Date('2026-07-20T17:30:00Z'));

  expect(hookCalls).toBe(1);
  expect(completed).toBe(0);

  const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
  expect(updated.status).toBe('in_progress');
  // No payments for a class that has not happened. This is the assertion that
  // makes the defect concrete: completion creates Payment rows.
  expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);

  await prisma.registration.deleteMany({ where: { classId: cls.id } });
  await prisma.class.delete({ where: { id: cls.id } });
});
```

In `src/services/class-lifecycle.test.ts`:

```ts
it('refuses to complete a class that has not ended when requireEndedBy is given', async () => {
  const cls = await makeClass({ status: 'in_progress' });
  // 18:00 Amsterdam = 16:00Z, 60 minutes long, so it ends at 17:00Z.
  const result = await completeClass(prisma, cls.id, {
    requireEndedBy: new Date('2026-07-20T16:30:00Z'),
  });
  expect(result.ok).toBe(false);
  const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
  expect(updated.status).toBe('in_progress');
});

it('still completes early for a teacher, who passes no requireEndedBy', async () => {
  // The option is what makes the sweep strict; omitting it must NOT become
  // strict by default, or a teacher can no longer finish a class early.
  const cls = await makeClass({ status: 'in_progress' });
  const result = await completeClass(prisma, cls.id);
  expect(result.ok).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts -t requireEndedBy`
Expected: FAIL — a TypeScript error on the third argument, or `expected false to be true`.
**Record the exact text.**

Run: `npx vitest run --project unit src/services/class-transitions.test.ts -t "rescheduled after the sweep read it"`
Expected: the new completion test FAILS with `expected 1 to be 0`, plus a non-zero
payment count. **Record both.**

The 'still completes early' test is expected to **PASS** before the change — it is a
regression guard against the option becoming mandatory. Say so in the report.

- [ ] **Step 3: Implement**

In `src/services/class-lifecycle.ts`, add the import:

```ts
import { classStartInstant } from '@/lib/timezone';
```

Change the signature and the `include`, and add the check after the existing
`if (!cls)` guard:

```ts
export async function completeClass(
  db: PrismaClient,
  classId: string,
  opts: { requireEndedBy?: Date } = {},
): Promise<TransitionDbResult> {
  return db.$transaction(async (tx) => {
    await lockClassRow(tx, classId);

    const cls = await tx.class.findUnique({
      where: { id: classId },
      include: {
        registrations: true,
        teacher: { select: { defaultTimezone: true } },
      },
    });
    if (!cls) return { ok: false, error: `Class not found: ${classId}` };

    // #182. The TIMING decision lives here, under the lock this function
    // already holds, rather than in the caller's pre-transaction snapshot.
    // `autoCompleteClasses` used to compute the end time from its outer
    // `findMany` and pass only the id, so a class rescheduled between that
    // read and this transaction was completed against a time it no longer
    // had — and completion runs the pricing engine and creates `Payment`
    // rows, so students were billed for a class whose start had moved.
    //
    // OPTIONAL, and that is the design rather than a convenience: the two
    // callers that omit it want exactly the old behaviour. A teacher
    // finishing early (`POST /api/classes/[id]/complete`) is legitimate, and
    // `deleteTeacherAccount` (`gdpr.ts`) completes in-flight classes during
    // erasure regardless of the clock. Making this mandatory would break
    // both.
    if (opts.requireEndedBy) {
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const end = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);
      if (opts.requireEndedBy < end) {
        return { ok: false, error: `Class ${classId} has not ended yet` };
      }
    }
```

The rest of the function is unchanged.

In `src/services/class-transitions.ts`, `autoCompleteClasses`' loop body:

```ts
    try {
      // Pre-filter from the snapshot, an OPTIMISATION ONLY — the authoritative
      // timing check now lives inside `completeClass`, under the row lock it
      // already takes. A stale pre-filter can only DELAY a completion to the
      // next 60-second tick, never cause a wrong one.
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const endTime = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);
      if (currentTime < endTime) continue;

      // `requireEndedBy` is what makes the decision the locked row's, not this
      // snapshot's. Without it this sweep completes a class rescheduled after
      // the read above — creating `Payment` rows for a class that has not
      // happened.
      const result = await completeClass(db, cls.id, { requireEndedBy: currentTime });
      if (result.ok) {
        completed++;
      } else {
        log.error({ classId: cls.id, reason: result.error }, 'class completion rejected');
      }
    } catch (err) {
      log.error({ err, classId: cls.id }, 'class completion failed');
    }
```

**Note the asymmetry with Task 4 and state it in the report:** this sweep *keeps* its
`log.error` on a rejected completion, because `completeClass` returns a typed refusal
rather than a silent `false`, and the pre-existing line already handles it. But a class
refused for `has not ended yet` is now a routine outcome. If the pre-existing tests
show this line firing on the new refusal, downgrade **that case only** to `log.warn`
and say why; do not silence the others.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project unit src/services/class-lifecycle.test.ts src/services/class-transitions.test.ts`
Then: `npx vitest run --project integration tests/integration/full-flow.test.ts`
(it calls `completeClass` directly at `:14`).
Expected: PASS.

- [ ] **Step 5: Mutation proof — two of them**

(a) Delete the `if (opts.requireEndedBy)` block. Re-run. Expected: **both** the
`class-lifecycle` refusal test and the `class-transitions` reschedule test FAIL.
**Record both texts.** Restore.

(b) Make the option mandatory — change `opts: { requireEndedBy?: Date } = {}` to
`opts: { requireEndedBy: Date }`. Expected: `tsc --noEmit` FAILS naming the two callers
that omit it. **Record the text.** Restore. This proves the optionality is load-bearing
rather than incidental.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-transitions.ts src/services/class-lifecycle.test.ts src/services/class-transitions.test.ts
git commit -m "fix: the completion sweep's timing decision moves under the lock

completeClass already held lockClassRow and already re-read the row; only
the timing decision was still the caller's stale one, and completion creates
Payment rows. requireEndedBy is optional because the teacher's early-finish
route and the erasure path both want the old behaviour.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: the attendance PUT is scoped by source status

**Files:**
- Modify: `src/app/api/registrations/[id]/route.ts:85-103`
- Test: `tests/integration/registrations-api.test.ts`

**Interfaces:** none new.

**Context — this is #182's acceptance 3, and it answers a product question, so read the
reasoning before changing the shape.**

The harmful move is a registration entering `ACTIVE_REGISTRATION_STATUSES`
(`registered`, `attended`, `no_show`) from outside it — `late_cancel → attended` — which
makes `autoCancelClasses`' in-transaction count too low and cancels a class that has
enough students. Scoping the write by **source** status closes it structurally: a
registration can then only move within the counted set.

**No `lockClassRow`.** The predicate is re-evaluated by Postgres at execution time,
which is the same reason the DELETE handler in this file scopes its own writes
(`:176-179`, `:192-195`) instead of locking.

**`completed` is deliberately allowed.** A teacher learns the exact no-shows *after* the
class — someone arrives a minute late, is let in, and the admin is not done at that
moment. All three accepted values are in `CHARGED_STATUSES`, so a post-completion
correction cannot change who is billed. Test 3 below exists to stop a future
lock-discipline pass closing this on tidiness grounds.

**No class-*time* guard.** Check-in legitimately runs before the class starts:
`AttendanceList` renders when `cls.status === 'in_progress' || (cls.status === 'open' &&
minutesToStart <= 15)` (`class/[id]/page.tsx:108`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/registrations-api.test.ts`. That file has
`async function makeClass(maxStudents: number): Promise<string>` at `:54` returning a
class id, a `studentIds: string[]` array of roster-linked students, and `ownerToken`.
Use them; `makeClass` already wires `ownerId` and `teacherRoomId` correctly.

```ts
it('409s attendance on a late-cancelled registration', async () => {
  const classId = await makeClass(4);
  const reg = await prisma.registration.create({
    data: { classId, studentId: studentIds[0]!, status: 'late_cancel', tierAtBooking: 3 },
  });
  const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
    body: JSON.stringify({ status: 'attended' }),
  });
  expect(res.status).toBe(409);
  const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
  expect(after.status).toBe('late_cancel');
});

it('409s attendance on a cancelled class', async () => {
  const classId = await makeClass(4);
  const reg = await prisma.registration.create({
    data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
  });
  // Cancelled AFTER the registration exists: a cancelled class cannot be booked.
  await prisma.class.update({ where: { id: classId }, data: { status: 'cancelled' } });

  const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
    body: JSON.stringify({ status: 'attended' }),
  });
  expect(res.status).toBe(409);
  const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
  expect(after.status).toBe('registered');
});

/**
 * A PRODUCT requirement pinned as a test, not a defect guard.
 *
 * A teacher does attendance admin AFTER the class, not during it: someone
 * arrives a minute late, is let in, and nobody stops to tap a checkbox. This
 * assertion exists so a future lock-discipline pass cannot quietly reject
 * `completed` alongside `cancelled` on the grounds that both are terminal.
 *
 * It is safe because all three values `updateRegistrationSchema` accepts are
 * in `CHARGED_STATUSES` (`class-lifecycle.ts`), so a correction made after
 * completion cannot change who is billed or by how much.
 */
it('allows attendance corrections on a completed class', async () => {
  const classId = await makeClass(4);
  const reg = await prisma.registration.create({
    data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
  });
  await prisma.class.update({ where: { id: classId }, data: { status: 'completed' } });

  const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
    body: JSON.stringify({ status: 'no_show' }),
  });
  expect(res.status).toBe(200);
  const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
  expect(after.status).toBe('no_show');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts -t 409s`
Expected: the two 409 tests FAIL with `expected 200 to be 409`. **Record the exact
texts.** The third test is expected to **PASS** already — it guards behaviour this task
must not break. Say so in the report.

- [ ] **Step 3: Implement**

In `src/app/api/registrations/[id]/route.ts`, the `PUT` handler:

```ts
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { class: { select: { teacherId: true, status: true } } },
  });

  if (!registration) return respondError('Registration not found', 404);
  if (registration.class.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  // #182. A cancelled class has no attendance to record.
  //
  // `completed` is DELIBERATELY absent from this check. A teacher learns the
  // exact no-shows after the class, not during it — someone arrives a minute
  // late, is let in, and nobody stops to tap a checkbox. All three values
  // `updateRegistrationSchema` accepts are in `CHARGED_STATUSES`
  // (`class-lifecycle.ts`), so a correction made after completion cannot
  // change who is billed. There is a test pinning this; it is a product
  // requirement, not an oversight.
  //
  // No guard on class TIME either, and that is also deliberate: check-in
  // renders on an `open` class within 15 minutes of its start
  // (`(teacher)/class/[id]/page.tsx`), so attendance before the class begins
  // is the designed flow.
  if (registration.class.status === 'cancelled') {
    return respondError('Cannot record attendance on a cancelled class', 409);
  }

  const parsed = await parseBody(request, updateRegistrationSchema);
  if ('error' in parsed) return parsed.error;

  // Status in the WHERE, not just a pre-check, for the same reason both DELETE
  // branches below scope their writes: this handler opens no transaction, so a
  // read-then-write races.
  //
  // What it closes: `autoCancelClasses` (`class-transitions.ts`) counts
  // registrations in `ACTIVE_REGISTRATION_STATUSES` under its row lock, then
  // CASes. This route takes no `Class` lock, so it can commit between the two.
  // A registration moving INTO that set — `late_cancel -> attended` — makes
  // the count too LOW and cancels a class that had enough students. Scoping
  // the SOURCE means a registration can only ever move WITHIN the counted set,
  // so the count cannot rise. Moves OUT stay possible and are harmless: they
  // make the count too high, and the class merely survives a sweep it might
  // have been cancelled in — a one-tick delay.
  //
  // A `Class` row lock would also close it, and is not used: this write moves
  // no money (`no_show` is in both `ACTIVE_REGISTRATION_STATUSES` and
  // `CHARGED_STATUSES`, so attendance changes no seat count and no price), and
  // locking the hottest row in the app to protect it is not proportionate.
  const updated = await prisma.registration.updateMany({
    where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
    data: { status: parsed.data.status },
  });
  if (updated.count === 0) {
    return respondError('Cannot record attendance on a cancelled registration', 409);
  }

  return respondOk({ id, status: parsed.data.status });
```

Note the response now returns `parsed.data.status` — `updateMany` returns a count, not
a row.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS, whole file — including the two pre-existing PUT tests at `:655` and
`:874`, which must still pass unchanged.

- [ ] **Step 5: Mutation proof — three of them**

(a) Drop `status: { notIn: [...] }` from the `where`. Re-run. Expected: the
late-cancelled test FAILS with `expected 200 to be 409`. **Record.** Restore.

(b) Drop the `class.status === 'cancelled'` reject. Re-run. Expected: the cancelled-class
test FAILS. **Record.** Restore.

(c) Add `'completed'` to the rejected class statuses. Re-run. Expected: the
**corrections-on-a-completed-class** test FAILS with `expected 409 to be 200`.
**Record.** Restore and re-verify all three.

Mutation (c) is the one that proves the product requirement is actually pinned rather
than merely commented.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/registrations/[id]/route.ts" tests/integration/registrations-api.test.ts
git commit -m "fix: attendance is scoped by source status, not by class lifecycle

The one move that corrupts autoCancelClasses' count is a registration
entering the counted set from outside it. Scoping the source closes that
structurally, with no Class row lock -- the same shape both DELETE branches
in this file already use.

completed stays writable on purpose: a teacher records the exact no-shows
after the class. A test pins that so a later tidy-up cannot close it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: the manual-cancel notice is built from an in-transaction re-read

**Files:**
- Modify: `src/app/api/classes/[id]/transition/route.ts:59-98`
- Test: `tests/integration/classes-api.test.ts`

**Interfaces:** none new.

**Context.** The cancel branch builds its notification body from `cls`, read at the top
of the handler **before `parseBody`'s await and outside the transaction** (`:25`). Since
`date` and `startTime` are not in `ECONOMIC_FIELDS`, a teacher can reschedule a booked
`open` class at any time, so a concurrent reschedule makes the notice name the wrong
day. `autoCancelClasses` re-reads inside its transaction for exactly this reason and
says so; this route does not.

**No new lock.** The CAS at `:36-39` is already the serialization point.

**The 24-line `KNOWN RESIDUAL` block at `:67-90` is DELETED, not rewritten.** The
comment at `:59-65` explaining why `relatedClassId` is inert stays — it is unrelated and
still true.

- [ ] **Step 1: Write the failing test**

The concurrency window is too narrow to drive from an HTTP test, so assert the
observable property instead: the notice names the class as it stands **at cancel time**.
Add to `tests/integration/classes-api.test.ts`:

```ts
it('names the class as it stands when cancelled, not as first read', async () => {
  const cls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Hatha',
      date: new Date('2099-01-01'),
      startTime: '10:00',
      durationMinutes: 60,
      roomCost: 30,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 4,
      status: 'open',
    },
  });
  await prisma.registration.create({
    data: { classId: cls.id, studentId: waitStudentId, status: 'registered', tierAtBooking: 3 },
  });
  // Rewrite the row after creation, so a handler interpolating anything other
  // than a fresh in-transaction read would name 'Hatha'.
  await prisma.class.update({ where: { id: cls.id }, data: { classType: 'Vinyasa' } });

  const res = await transition(ownerToken, cls.id, { status: 'cancelled' });
  expect(res.status).toBe(200);

  const notice = await prisma.notification.findFirstOrThrow({
    where: { relatedClassId: cls.id, type: 'class_cancelled', recipientType: 'student' },
  });
  expect(notice.body).toContain('Vinyasa');
  expect(notice.body).not.toContain('Hatha');

  await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
  await prisma.registration.deleteMany({ where: { classId: cls.id } });
  await prisma.class.delete({ where: { id: cls.id } });
});
```

This test **passes before the change** (the top-of-handler read happens after the
update). It is a characterisation test that locks the property in; the *proof* is
mutation (a) in step 5, which is what distinguishes the two reads. State this plainly
in the report — do not claim it as a failing-first test.

- [ ] **Step 2: Run the test and confirm it passes for the stated reason**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts -t "as it stands when cancelled"`
Expected: PASS. Confirm in the report that it passes *before* the implementation, and
why that is expected here rather than a broken test.

- [ ] **Step 3: Implement**

In `src/app/api/classes/[id]/transition/route.ts`, inside the cancel transaction, after
the `waitlistEntry.updateMany` block and before the notifications are built:

```ts
      // Re-read under the CAS above, which is this transaction's serialization
      // point — not from `cls`, the handler's top-of-function read, which was
      // taken before `parseBody`'s await and outside this transaction.
      //
      // `date` and `startTime` are NOT in `ECONOMIC_FIELDS`
      // (`lib/class-fields.ts`), so `settingsLocked` does not freeze them and a
      // teacher can reschedule a booked open class at any time. Reschedule
      // while cancelling and the notice named the old day. `autoCancelClasses`
      // (`class-transitions.ts`) re-reads inside its own transaction for
      // exactly this reason and says so; this route now matches it.
      //
      // No new lock: the CAS already holds this row.
      const fresh = await tx.class.findUniqueOrThrow({
        where: { id },
        select: { classType: true, date: true, startTime: true },
      });
```

Change the notification body to interpolate from `fresh`:

```ts
        body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} has been cancelled by your teacher.`,
```

Delete the `KNOWN RESIDUAL` block (`:67-90`), keeping `:59-65`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Mutation proof**

Revert the body to interpolate from `cls` instead of `fresh` (leaving the `findUniqueOrThrow`
in place so the change is one identifier). Re-run.

Expected: the new test FAILS — `expected '…Hatha class on…' not to contain 'Hatha'`.
**Record the exact text.** This is what proves the two reads are distinguishable; without
it the re-read is untested code. Restore and re-verify.

If it does **not** fail, stop and report: the test cannot tell the two reads apart and
needs redesigning before this task can be called done.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/classes/[id]/transition/route.ts" tests/integration/classes-api.test.ts
git commit -m "fix: the cancel notice names the class as it stands, not as first read

Four lines and no new lock -- the CAS is already the serialization point.
Deletes the KNOWN RESIDUAL note that recorded this, rather than rewriting it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: the `expired` display fixture

**Files:**
- Modify: `tests/integration/waitlist-display.test.ts:226-260`

**Interfaces:** none.

**Context — this task exists because that file asked for it by name.** Its comment at
`:245-248` reads:

> `expired` is absent because nothing in `src` writes it. If #216 chooses `expired` as
> the state that closes a queue when a class starts, add a row here the same day —
> otherwise `notIn: ['removed','promoted','claimed']` becomes a live leak this fixture
> cannot see.

Task 1 makes `expired` reachable in production. This closes the loop.

The count fixture currently carries one entry in each of four states — `waiting`,
`promoted`, `claimed`, `removed` — on a class with `maxStudents: 4`. Each was added
because a wrong predicate survived without it. A fifth, `expired`, is now required.

- [ ] **Step 1: Write the failing test**

Add a fifth student and a fifth entry to the count fixture, and rewrite the comment.
Read `:226-270` for the exact fixture shape and student-creation helper before editing;
match it rather than inventing.

```ts
  const lapsed = await makeStudent('count-expired');
```

and in the `createMany`:

```ts
      { classId: countClassId, studentId: lapsed.id, position: 5, status: 'expired',
        promotedAt: new Date() },
```

Replace the `expired` paragraph of the comment with:

```
  // - `expired` kills `status: { notIn: ['removed','promoted','claimed'] }`,
  //   the negative enumeration one step further out again. No longer
  //   hypothetical: `closeQueueOnStart` (`waitlist.ts`, #216) writes it every
  //   time a class starts with an unfulfilled queue, which is the ordinary
  //   case for any class that filled. It is the third of the three
  //   double-counts the production comment names.
```

The assertion that already reads the filtered count must now expect the same number as
before — **one** `waiting` row against four closed ones — because the fixture grew by a
closed row, not a live one. Update the "one in each of four states" phrasing in the
comment's opening line to five.

- [ ] **Step 2: Run the test and verify it fails**

First, **prove the fixture bites** before adding the row: temporarily change the
production predicate at `src/app/(teacher)/class/[id]/page.tsx:60` from
`where: { status: 'waiting' }` to `where: { status: { notIn: ['removed', 'promoted', 'claimed'] } }`.

Run: `npx vitest run --project integration tests/integration/waitlist-display.test.ts`

Expected **without** the new fixture row: PASS — which is the leak the file's comment
predicted. Expected **with** it: FAIL, `expected 2 to be 1`.

**Record both results.** This ordering is the whole point of the task: a fixture that
would pass either way certifies nothing. Restore the production predicate.

- [ ] **Step 3: Implement**

Already done in step 1 — this task's deliverable *is* the fixture. Keep the production
predicate restored to `where: { status: 'waiting' }`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run --project integration tests/integration/waitlist-display.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation proof**

Already performed as step 2's first half — the mutation is the negative-enumeration
predicate, and the fixture is what makes it fail. Restate both recorded outputs in the
task report side by side, since the pass-then-fail pair *is* the proof.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/waitlist-display.test.ts
git commit -m "test: the fifth waitlist state, added the same day it became reachable

This file asked for it by name: expired was absent because nothing wrote it,
and a notIn enumeration would have leaked it silently. closeQueueOnStart now
writes it on every class that starts with a queue.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: reconcile every claim this branch made false

**Files:** the twelve locations in the spec's §4, plus anything the diff reveals.

**Interfaces:** none.

**Context — do not run this task from a keyword grep.** The procedure that failed on
#41 was grepping for one finding's phrase and declaring the sweep clean while another
finding's twin sat untouched three hundred lines away. The procedure that works:

1. `git diff main...HEAD --name-only` — the files this branch **changed**
2. the §4 table — the files it was **supposed** to change
3. reconcile the two sets, and report both differences in either direction

- [ ] **Step 1: List what the branch changed**

```bash
git diff main...HEAD --name-only
git diff main...HEAD --stat
```

Record the output in the task report. Any file in §4's table that is **absent** from
this list is an unfixed claim; any file present that §4 does not mention needs a stated
reason.

- [ ] **Step 2: Correct each location**

| Location | Correction |
|---|---|
| `src/services/waitlist-reconciliation.ts:160-183` | The `class: { status: 'open' }` join is now redundant rather than load-bearing. **Narrow the comment; do not delete it, and do not remove the join** — it is a cost bound, not a correctness guard, so removing it fails no test by design (#222). Say that the growth it describes is closed at source by `closeQueueOnStart`, and that the join is kept because it still bounds the scan. Update the six-writer enumeration to seven. |
| `src/app/(student)/bookings/page.tsx:41-62` | "nothing closes the queue when a class leaves `open` by starting (#216)" and "#216 is now the only drain" are both false. The `class: { status: 'open' }` predicate stays — it is still correct and still the right shape — but the reason changes: it now guards pre-existing rows and belt-and-braces, not an open hole. |
| `src/services/class-transitions.ts:200-211` | Two corrections in one block. The PUT "is not a normal thing to do" is **wrong** — check-in renders on an `open` class within 15 minutes of start, so it is the designed flow — and the gap is now **closed** by Task 6's source-status scope. Rewrite to state what actually protected it (the UI only writes within the counted set) and what protects it now. |
| `src/services/class-transitions.ts:253-258` | "The identical stale-window race is still live in `autoTransitionToInProgress` above and `autoCompleteClasses` below" — both fixed in Tasks 4 and 5. Delete or rewrite to point at them. |
| `src/services/class-transitions.ts:218-230` | The enumeration of `WaitlistEntry` writers gains `closeQueueOnStart`. Count and re-state. |
| `src/services/waitlist.ts:722-724` | Narrow, do not delete: the PUT now guards **current registration status** and **class status**, and still does not guard **class time**, deliberately. **It cites `class-transitions.ts:199` by line number and this branch moves that block** — re-derive the number or drop it in favour of naming the comment. |
| `src/services/waitlist.ts:861-875` | "two writers flip `WaitlistEntry.status` from `waiting` to `removed`" — a third writer now exists and writes `expired`. It takes the `Class` row lock via `lockClassRow` (sweep, `completeClass`) or via the CAS `UPDATE` (`transitionClass`), so the paragraph's conclusion holds; the count and the enumeration do not. |
| `docs/lock-order.md` | **0 occurrences of either sweep today.** Both become conforming sites: add `autoTransitionToInProgress` to "Known conformance" (`:598+`) alongside `autoCancelClasses`, and add it to the "Classes per transaction" table (`:223+`) as "one — `cls.id`, and one transaction per class". `autoCompleteClasses` takes no lock of its own — its entry belongs under `completeClass`, which is already listed; extend that row to say the timing decision now lives under the same lock. |
| `src/services/gdpr.ts:288-298` | **Do not change the `waitingCount` query.** Add one sentence noting the population it counts no longer grows, now that `closeQueueOnStart` closes rows at source. |
| `src/app/api/classes/[id]/transition/route.ts:67-90` | Already deleted in Task 7 — confirm it is gone. |
| `tests/integration/waitlist-display.test.ts` | Already done in Task 8 — confirm. |
| `src/services/class-lifecycle.ts` `CHARGED_STATUSES` docblock (`:160-174`) | It names `class-transitions.test.ts` and `tests/integration/registrations-api.test.ts` as citing it, "one of them by line number, which this docblock's own growth has already invalidated once". Both files change in this branch — re-check that citation. |
| **Three test-teardown comments this branch itself wrote, all stating a false FK mechanism.** `src/services/class-lifecycle.test.ts` (~`:314-319` and ~`:668-673`) and `tests/integration/classes-api.test.ts` (~`:240-241`) | Each says the `WaitlistEntry` row "blocks `class.deleteMany`". **It does not.** `WaitlistEntry.class` is `onDelete: Cascade` (`prisma/schema.prisma:575`), so waitlist rows go with their class. The row that actually blocks teardown is the surviving **`Class`**, and what it blocks is `teacherRoom.deleteMany` / `room.delete` via the plain `Class.teacherRoomId` FK — which the `classes-api.test.ts` comment states correctly at `~:237-238` before appending the wrong reason for the waitlist line. **Keep the `waitlistEntry.deleteMany` calls** (harmless, mildly defensive) and correct the stated reason in all three places. This claim originated in the controller's own task dispatches, not in an implementer's reasoning — record that in the PR body, since "where the errors were, including your own" is the standard this project holds. |

- [ ] **Step 3: Correct the issue bodies and the roadmap**

This is **#216 acceptance 4**. #199's inherited claim — *"#195 fixes forward only … the
population is bounded and no longer grows"* — is false and stands in two places:

```bash
gh issue view 199 --json body -q .body | grep -n "bounded"
grep -n "bounded" docs/backlog-roadmap.md
```

Post the correction to issue 199 as a comment **from a `--body-file`, never
`--body "…"`** — backticks inside a double-quoted shell string reach zsh as command
substitution even escaped, and it fails *silently*, publishing a sentence with pieces
eaten. Write the markdown to the scratchpad and pass the path.

`docs/backlog-roadmap.md` is untracked and local — **edit it, never stage it.**

- [ ] **Step 4: Point the code at the issue that will be filed for §6.1**

The spec spins out one issue: **attendance cannot be edited after a class completes**,
because `AttendanceList` renders only under `showCheckin` and
`autoCompleteClasses` flips the class within 60 seconds of its scheduled end. It is
filed rather than folded — see the spec §6.1.

It cannot be filed from inside a task (the number does not exist yet), so this step
records the two places that must point at it once it does, for whoever files it:

1. `src/app/api/registrations/[id]/route.ts` — the `completed`-is-deliberate comment
   from Task 6 should name the issue number, so the next reader of that guard finds the
   UI work rather than concluding the allowance is an oversight.
2. `src/app/(teacher)/class/[id]/page.tsx:108` — a comment beside `showCheckin`, since
   that expression *is* the gap. This is the "sometimes the right home is a comment"
   case: a future reader needs it at the moment they touch that line.

**Do not invent an issue number.** Leave both comments referring to the behaviour, and
report that the number has to be back-filled after filing. The issue must also carry:

- the "No-show" label conflation (`attendance-list.tsx:27` renders `registered` and
  `no_show` identically), which is what makes an auto-flip look attractive
- the spec §2.4 decision **not** to auto-flip `registered → no_show`, with its reasoning:
  it fabricates an observation the system never made, and `exportStudentData` publishes
  it, so a student who attended could read `no_show` in their own data

- [ ] **Step 5: Verify the whole tree**

```bash
npm run verify
```

Expected: green. Record files and tests per project and reconcile the totals, as the
baseline in this plan's header does. **Measure; do not predict.**

This is not optional and not a substitute for CI: `verify` runs the same static gates
and the same vitest suite, but CI additionally runs `prisma validate`, a migration-drift
check, `npm run build` and Playwright. A build-only defect passes `verify` and fails CI.

- [ ] **Step 6: Confirm no accidental closing keyword**

```bash
git log main...HEAD --format=%B | grep -inE '(close[sd]?|fix(e[sd])?|resolve[sd]?) +#[0-9]+'
```

Expected: **no matches.** A case-sensitive grep here would return zero the way a clean
tree does, which is why `-i` is used — the check must be able to fire.

- [ ] **Step 7: Commit**

```bash
git add src/services/waitlist-reconciliation.ts "src/app/(student)/bookings/page.tsx" src/services/class-transitions.ts src/services/waitlist.ts src/services/gdpr.ts src/services/class-lifecycle.ts "src/app/api/registrations/[id]/route.ts" "src/app/(teacher)/class/[id]/page.tsx" docs/lock-order.md
git commit -m "docs: every claim this branch made false, reconciled against its diff

Derived from git diff --name-only against the spec's list, not from a
keyword sweep -- a grep scoped to one claim cannot see another claim's twin.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Stop Conditions

Stop and report rather than working around, if:

- **A test fails for a reason other than the one this plan predicts.** A test that fails
  for the wrong reason proves nothing about the fix.
- **A mutation does not fail its test.** That is the finding — the guard cannot fail.
  Report it; do not adjust the mutation until it does.
- **Task 8's step 2 first half does not PASS.** If the negative-enumeration predicate
  already fails without the new fixture row, the fixture is not testing what the file's
  comment says it is, and the whole task needs redesigning.
- **`tsc --noEmit` reports an import cycle** between `waitlist.ts` and
  `class-lifecycle.ts`.
- **Any pre-existing test changes behaviour.** In particular
  `class-transitions.test.ts:167` (early-local-morning classes) and the two PUT tests at
  `registrations-api.test.ts:655` and `:874`. Report; do not edit the test to match the
  new code.

## What the PR body must record

- The measured before/after test counts, per project, with arithmetic that reconciles.
- Which inherited claims were checked and which held — including the three from the spec
  §1.3 and §1.5 that did **not**.
- Every mutation, with the exact failure text recorded.
- That `npm run verify` ran green, and the arithmetic proving the whole `integration`
  project ran — not the outdated "integration is never run in full".
- The `integration` files this branch touched, **by path**: `tests/integration/classes-api.test.ts`,
  `tests/integration/registrations-api.test.ts`, `tests/integration/waitlist-display.test.ts`.
- What the PR does **not** do — using "**#N is unaffected**", never the phrase that
  GitHub's parser closes on.
- That #182's `PUT` class-*time* guard was deliberately not added, and why.
