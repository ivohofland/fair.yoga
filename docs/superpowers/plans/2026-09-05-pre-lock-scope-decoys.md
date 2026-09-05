# Cross-owner decoys for the `Class` pre-locks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each of the five owner/parent-scoping conjuncts in the four
`lockClassRowsOrdered` call sites fail a test when deleted, by giving every site
a decoy row the correct predicate excludes and a widened one would reach.

**Architecture:** Test-only. Each site gets a new test block in the test file of
the service that owns the predicate. Every block captures the ids the pre-lock
actually locked — by spying on `dbLocks.lockClassRowsOrdered` and calling
through to the real implementation — and asserts that set is exactly the
fixture's own rows. Two sites additionally assert a decoy row survived, which is
possible only where the write is keyed on the lock's returned ids.

**Tech Stack:** Vitest (`unit` project, parallel tier, `ethical_yoga_test`),
Prisma, `tests/class-fixtures.ts`'s `createClassFixture`.

**Spec:** `docs/superpowers/specs/2026-09-05-pre-lock-scope-decoys-design.md`

> **Record, not current state.** The code blocks below are AS-DISPATCHED, not
> as-shipped; the test files are what shipped. Inline annotations mark the
> places a task's own fix round overturned the text you are reading, and two
> errors run through the document generally. (a) The Architecture line's "two
> sites": all three blocks shipped a decoy-survival assertion. (b) The framing
> of those assertions as witnesses: the lock-set equality assertion sits above
> every one of them and fails first, so under a pre-lock widening the survival
> assertion never executes — whether or not the write reaches the row. See the
> spec's shadowing note ("The scoping conjuncts are five, and they are not
> alike").

## Global Constraints

- **No production code changes.** This branch touches only `*.test.ts` files.
  All five conjuncts are correct today; what is missing is the proof. A task
  that finds itself editing `src/services/*.ts` other than to apply a
  *temporary* mutation has gone wrong.
- **A passing new test proves nothing on its own.** These tests are written
  against correct code, so they pass on arrival. The deliverable of each task is
  the recorded MUTATION evidence: delete the conjunct, watch the new assertion
  fail, restore, watch it pass. A conjunct whose mutation does not fail the new
  assertion is not covered, whatever the assertion says.
- **Every block asserts the spy fired exactly once** (`toHaveLength(1)`). This
  is not decoration: it is what catches a fixture whose precondition silently
  skipped the pre-lock, and what makes a future sibling statement fail by name.
- **Restore mutations with an editor, not `git checkout`.** Checking out a file
  discards any other uncommitted edit in it. Commit before mutating; restore by
  reversing the edit.
- **Never `git add -A`.** Stage exact paths.
- All three files run in the `unit` project. Command shape:
  `npx vitest run --project unit <path>`.
- Do not start, stop or restart the dev server on `:3000`. These tests need no
  running app.
- Test dates are far-future (`2099-…`) so no class is ever accidentally past.
- `CalendarEntry_teacher_slot_excl` refuses two overlapping LIVE entries for one
  teacher. Where one teacher owns two classes, give them different **dates** —
  robust regardless of start time.

---

### Task 1: `gdpr.ts` — both erasure pre-locks

Covers `e."teacherId"` (`gdpr.ts:1135`) and `w."studentId"` (`gdpr.ts:442`).

**Files:**
- Modify: `src/services/gdpr.test.ts` — append a new `describe` at end of file
  (currently ends at line 3155, after `describe('the cancellable-status
  classification reaches the pre-lock (#245)', …)`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the `captureLockSets` spy idiom that Tasks 2 and 3 repeat. It is
  deliberately COPIED into each file rather than shared — these three test files
  have independent fixtures and a cross-suite test helper would couple them, the
  same reasoning `gdpr-lock-order.test.ts:285` records for mirroring
  `forceIndexOrderedPlan` instead of importing it.

**No new imports needed.** `src/services/gdpr.test.ts` already imports
`vi`, `onTestFinished`, `crypto`, `PrismaClient`, `deleteStudentAccount`,
`deleteTeacherAccount`, `* as dbLocks from '@/lib/db-locks'`, `hhmmToTime`, and
`createClassFixture`.

- [ ] **Step 1: Append the new describe with its fixture**

Append to `src/services/gdpr.test.ts`. Note the local `const prisma` and the
`$disconnect()` in `afterAll` — the convention the `(#245)` describe above it
follows.

```ts
/**
 * ONE DECOY SERVES BOTH CONJUNCTS. `classD` belongs to a different teacher AND
 * carries a different student's waiting entry, so `e."teacherId" =
 * victimTeacher` excludes it and `w."studentId" = victimStudent` excludes it
 * too — and either conjunct's deletion pulls it into that pre-lock's set.
 *
 * What this adds over `gdpr-lock-order.test.ts`'s lock-set assertion, which
 * already pins the ids both erasures lock: that assertion proves the set's SIZE
 * and MEMBERS for a fixture containing nothing the predicate should reject, so
 * a widened `WHERE` fails it only if some unrelated qualifying row happens to
 * be in the shared database. Measured on 2026-09-05: dropping
 * `e."teacherId"` failed it while one orphaned class from another suite sat in
 * `ethical_yoga_test`, and passed once that row left predicate scope. The decoy
 * below is always present, so the failure is a construction rather than a
 * coincidence.
 */
describe('the erasure pre-locks are scoped to their own owner (#453)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-scope-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let victimTeacherId: string;
  let victimTeacherAccountId: string;
  let decoyTeacherId: string;
  let decoyTeacherAccountId: string;
  let roomId: string;
  let victimStudentId: string;
  let victimStudentAccountId: string;
  let decoyStudentId: string;
  let classAId: string;
  let classDId: string;
  let classDEntryId: string;

  beforeAll(async () => {
    const victimTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Scope',
        lastName: 'Victim',
        email: `${suffix}-victim@test.local`,
        account: { create: { email: `${suffix}-victim@test.local` } },
        bio: 'Scope fixture',
        pageSlug: `${suffix}-victim`,
      },
      select: { id: true, accountId: true },
    });
    victimTeacherId = victimTeacher.id;
    victimTeacherAccountId = victimTeacher.accountId;

    const decoyTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Scope',
        lastName: 'Bystander',
        email: `${suffix}-decoy@test.local`,
        account: { create: { email: `${suffix}-decoy@test.local` } },
        bio: 'Scope decoy',
        pageSlug: `${suffix}-decoy`,
      },
      select: { id: true, accountId: true },
    });
    decoyTeacherId = decoyTeacher.id;
    decoyTeacherAccountId = decoyTeacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Scope Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234SC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: victimTeacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    // A `TeacherRoom` per teacher on the one shared `Room`: the rate is
    // per-teacher and never shared, so the decoy needs its own row.
    const victimRoom = await prisma.teacherRoom.create({
      data: { teacherId: victimTeacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });
    const decoyRoom = await prisma.teacherRoom.create({
      data: { teacherId: decoyTeacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      classType: 'Scope class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };

    const classA = await createClassFixture(prisma, {
      ...base,
      teacherId: victimTeacherId,
      teacherRoomId: victimRoom.id,
      date: new Date('2099-06-01'),
    });
    classAId = classA.id;

    const classD = await createClassFixture(prisma, {
      ...base,
      teacherId: decoyTeacherId,
      teacherRoomId: decoyRoom.id,
      date: new Date('2099-06-01'),
    });
    classDId = classD.id;
    classDEntryId = classD.calendarEntry.id;

    // WITH an account: `deleteStudentAccount` erases sessions and the account
    // row, so a student without one is not the shape under test.
    const victimStudent = await prisma.student.create({
      data: {
        firstName: 'Scope',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-student@test.local` } },
      },
      select: { id: true, accountId: true },
    });
    victimStudentId = victimStudent.id;
    victimStudentAccountId = victimStudent.accountId!;

    // No account: nothing erases this one.
    const decoyStudent = await prisma.student.create({
      data: {
        firstName: 'Scope',
        lastName: 'Waiter',
        email: `${suffix}-waiter@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    decoyStudentId = decoyStudent.id;

    await prisma.waitlistEntry.create({
      data: { classId: classAId, studentId: victimStudentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: classDId, studentId: decoyStudentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    const studentIds = [victimStudentId, decoyStudentId];
    const teacherIds = [victimTeacherId, decoyTeacherId];
    await prisma.notification.deleteMany({ where: { recipientId: { in: [...studentIds, ...teacherIds] } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await prisma.account.deleteMany({
      where: { id: { in: [victimTeacherAccountId, decoyTeacherAccountId, victimStudentAccountId] } },
    });
    await prisma.$disconnect();
  });

  /**
   * The ids the pre-lock ACTUALLY held, read off the helper rather than
   * re-derived from a fixture. Calls through, so the erasure runs for real —
   * the same shape as the fragment-reading spy in the describe above, which
   * reads `source.where` where this reads the return value.
   *
   * A text pin on `source.where` could not replace this: `.strings` is the
   * tagged template's STATIC text, so the owner id renders as `?` and a
   * predicate scoped to the WRONG owner reads identically to the right one.
   */
  const captureLockSets = (): string[][] => {
    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());
    return lockSets;
  };

  // WRONG, AND CORRECTED IN TASK 1's FIX ROUND — kept here only so the diff
  // that removed it makes sense. This comment claimed the order was
  // load-bearing because the teacher erasure cancels `classA`'s entry and a
  // cancelled REGULAR entry is terminal. Both halves are false:
  // `deleteStudentAccount` writes no `CalendarEntry` column, and its pre-lock
  // has no liveness filter, so a cancelled `classA` still matches. Swapping
  // the two tests leaves the file 37/37. What to write instead is in the fix
  // round's dispatch and in the spec's section A.
  it('locks only classes the erased student actually waits in', async () => {
    const lockSets = captureLockSets();

    await deleteStudentAccount(prisma, victimStudentId);

    expect(lockSets).toHaveLength(1);
    // `classD` carries a waiting entry too — just not this student's. Drop
    // `w."studentId"` from the pre-lock and it appears here.
    expect(lockSets[0]).toEqual([classAId]);

    // The decoy's entry is untouched. HONEST ABOUT WHAT THIS CATCHES: it
    // cannot fail on a widened pre-lock, because the `waitlistEntry.deleteMany`
    // re-scopes on `studentId` independently. It guards that `deleteMany`'s own
    // scope, which is a different regression.
    const decoyEntry = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classDId, studentId: decoyStudentId },
    });
    expect(decoyEntry.status).toBe('waiting');
  });

  it('locks only the erased teacher’s own classes, and cancels no one else’s', async () => {
    const lockSets = captureLockSets();

    await deleteTeacherAccount(prisma, victimTeacherId);

    expect(lockSets).toHaveLength(1);
    expect(lockSets[0]).toEqual([classAId]);

    // WRONG, AND CORRECTED IN TASK 1's FIX ROUND — kept here only so the diff
    // that rewrote it makes sense. The cancellation is real (the cancel loop
    // reads exactly the ids the lock returned, and the bystander's entry came
    // back cancelled under the mutation, unrestorably), but this assertion is
    // not what reports it: the lock-set assertion above throws first and this
    // line never executes. The `class.count` line below was deleted outright —
    // a teacher erasure cancels entries, it never deletes `Class` rows, so it
    // could not fail on any mutation of this predicate. What shipped is in
    // `gdpr.test.ts`.
    // THE DATA-LOSS WITNESS, and the one assertion here that a widening
    // actually destroys: a pre-lock that reaches `classD` cancels it, because
    // the cancel loop reads exactly the ids the lock returned. Measured
    // 2026-09-05 against the mutation — the bystander's entry came back
    // cancelled, and the database then refused to restore it.
    const decoyEntry = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: classDEntryId } });
    expect(decoyEntry.cancelledAt).toBeNull();
    expect(await prisma.class.count({ where: { id: classDId } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run the new tests — expect PASS**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: the whole file passes, including both new tests. A pass here is NOT
the deliverable — production code is correct, so a correctly-written test must
pass. What it rules out is a broken fixture. If either new test fails, the
fixture is wrong (a slot-constraint refusal, a missing account, a spy that never
fired — `toHaveLength(1)` names that last one).

- [ ] **Step 3: Commit the tests before mutating anything**

```bash
git add src/services/gdpr.test.ts
git commit -m "test(gdpr): cross-owner decoy proves both erasure pre-locks are scoped (#453)"
```

Committing first is what makes the mutations below safely reversible.

- [ ] **Step 4: Mutation 1 — drop the teacher conjunct**

In `src/services/gdpr.ts:1135`, remove the first conjunct so the pre-lock reads:

```ts
        where: Prisma.sql`e."cancelledAt" IS NULL
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})`,
```

**This mutation writes outside its fixture and one of its effects cannot be
undone.** It cancels every qualifying `CalendarEntry` in `ethical_yoga_test`,
and `entry_terminal_liveness_guard` refuses to un-cancel a terminal REGULAR
entry. Before running, record what it will touch:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
  "SELECT c.id, e.id AS entry_id, e.\"teacherId\" FROM \"Class\" c \
   JOIN \"CalendarEntry\" e ON e.id=c.\"calendarEntryId\" \
   WHERE e.\"cancelledAt\" IS NULL AND c.status IN ('draft','open','in_progress');"
```

Report any row in that list that is not this describe's own fixture — it will be
collateral, and it is debris from abandoned fixtures rather than anything a test
depends on, but it must be named in the task report, not silently absorbed.

- [ ] **Step 5: Run — expect the teacher test RED, naming the decoy**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: `locks only the erased teacher's own classes, and cancels no one
else's` fails on the lock-set assertion, with the decoy's class id present in
the received array alongside `classAId`. Record the exact output in the task
report. (If the run reaches the `cancelledAt` assertion instead, record that
too — either failure proves the conjunct is covered, but which one fires first
is worth knowing.)

- [ ] **Step 6: Restore, and confirm green**

Reverse the Step 4 edit — restore `e."teacherId" = ${teacherId}` as the first
conjunct. Do NOT use `git checkout`. Then:

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: PASS. Confirm `git diff src/services/gdpr.ts` is empty.

- [ ] **Step 7: Mutation 2 — drop the student conjunct**

In `src/services/gdpr.ts:442`, replace the predicate with one true of every
waitlisted class. The `where` member is required and an empty fragment would be
a syntax error, so widen rather than delete:

```ts
      where: Prisma.sql`w."position" >= 0`,
```

This one is safe: it widens the lock set only, because the erasure's
`waitlistEntry.deleteMany` re-scopes on `studentId` independently.

- [ ] **Step 8: Run — expect the student test RED**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: `locks only classes the erased student actually waits in` fails, with
`classD`'s id in the received array. Record the exact output.

- [ ] **Step 9: Restore, confirm green, commit nothing**

Reverse the Step 7 edit to `where: Prisma.sql\`w."studentId" = ${studentId}\``.

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: PASS, and `git diff src/services/gdpr.ts` empty. There is nothing to
commit — the test commit landed in Step 3, and the mutations are evidence, not
changes.

---

### Task 2: `waitlist.ts` — `withdrawWaitingEntriesForTeacher`

Covers `e."teacherId"` and `w."studentId"` (`waitlist.ts:1094-1095`).

**Files:**
- Modify: `src/services/waitlist.test.ts` — new imports at top, new `describe`
  appended at end of file (2186 lines today)

**Interfaces:**
- Consumes: the `captureLockSets` idiom from Task 1, copied not imported.
- Produces: nothing later tasks rely on.

**Why this file, driving an `invitations.ts` entry point:** the predicate under
test belongs to `waitlist.ts`, so its proof belongs beside it — but
`withdrawWaitingEntriesForTeacher` takes a branded `TransactionClientOnly`, and
reaching it directly needs a cast that subverts the brand. Its only production
caller, `unlinkTeacher` (`invitations.ts:1019`), takes a plain `PrismaClient`
and opens its own transaction, so the real path runs and no cast is needed.

- [ ] **Step 1: Add the imports**

`src/services/waitlist.test.ts` currently imports
`{ describe, it, expect, beforeAll, afterAll }` from `'vitest'` and has no
`dbLocks` or `unlinkTeacher` import. Change the vitest import to add `vi` and
`onTestFinished`, and add two module imports:

```ts
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
```

```ts
import * as dbLocks from '@/lib/db-locks';
import { unlinkTeacher } from './invitations';
```

- [ ] **Step 2: Append the new describe with its fixture**

Two decoys, one per conjunct. `classT` and `classT3` share teacher `T`, so they
get different DATES rather than different times — no overlap is possible across
dates, whatever `CalendarEntry_teacher_slot_excl` computes.

```ts
/**
 * TWO DECOYS, because this predicate has two owner conjuncts and they fail
 * differently.
 *
 * `classT2` — student S waiting on ANOTHER TEACHER's class — is the
 * data-observable one: the `updateMany` this pre-lock brackets is keyed on the
 * returned ids and on `studentId`, so dropping `e."teacherId"` withdraws a
 * standing request S made of a teacher they never unlinked from.
 *
 * `classT3` — ANOTHER STUDENT waiting on T's class — is not data-observable at
 * all, because that same `updateMany` re-scopes on `studentId`. Dropping
 * `w."studentId"` widens the lock set and writes nothing extra, so the lock-set
 * assertion is the only thing that can witness it. That asymmetry is why this
 * test asserts the ids at all rather than only the surviving rows.
 */
describe('withdrawWaitingEntriesForTeacher locks only the pair it was given (#453)', () => {
  const scopeSuffix = `wl-scope-${Date.now()}`;
  let teacherTId: string;
  let teacherTAccountId: string;
  let teacherT2Id: string;
  let teacherT2AccountId: string;
  let scopeRoomId: string;
  let studentSId: string;
  let studentSEmail: string;
  let studentS2Id: string;
  let classTId: string;
  let classT2Id: string;
  let classT3Id: string;

  beforeAll(async () => {
    const teacherT = await prisma.teacher.create({
      data: {
        firstName: 'Unlink',
        lastName: 'Teacher',
        email: `${scopeSuffix}-t@test.local`,
        account: { create: { email: `${scopeSuffix}-t@test.local` } },
        bio: 'Unlink scope fixture',
        pageSlug: `${scopeSuffix}-t`,
      },
      select: { id: true, accountId: true },
    });
    teacherTId = teacherT.id;
    teacherTAccountId = teacherT.accountId;

    const teacherT2 = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `${scopeSuffix}-t2@test.local`,
        account: { create: { email: `${scopeSuffix}-t2@test.local` } },
        bio: 'Unlink scope decoy',
        pageSlug: `${scopeSuffix}-t2`,
      },
      select: { id: true, accountId: true },
    });
    teacherT2Id = teacherT2.id;
    teacherT2AccountId = teacherT2.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Unlink Studio',
        address: `${scopeSuffix} St`,
        city: 'Amsterdam',
        postcode: '1234UL',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherTId,
      },
      select: { id: true },
    });
    scopeRoomId = room.id;

    const roomT = await prisma.teacherRoom.create({
      data: { teacherId: teacherTId, roomId: scopeRoomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });
    const roomT2 = await prisma.teacherRoom.create({
      data: { teacherId: teacherT2Id, roomId: scopeRoomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      classType: 'Unlink scope class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };

    // T's class that S waits in — the ONLY row the correct predicate matches.
    const classT = await createClassFixture(prisma, {
      ...base,
      teacherId: teacherTId,
      teacherRoomId: roomT.id,
      date: new Date('2099-07-01'),
    });
    classTId = classT.id;

    // Decoy 1: ANOTHER teacher's class, same student waiting.
    const classT2 = await createClassFixture(prisma, {
      ...base,
      teacherId: teacherT2Id,
      teacherRoomId: roomT2.id,
      date: new Date('2099-07-01'),
    });
    classT2Id = classT2.id;

    // Decoy 2: T's class again, a DIFFERENT student waiting. A different date
    // from `classT`, so the two live entries of one teacher cannot overlap.
    const classT3 = await createClassFixture(prisma, {
      ...base,
      teacherId: teacherTId,
      teacherRoomId: roomT.id,
      date: new Date('2099-07-02'),
    });
    classT3Id = classT3.id;

    studentSEmail = `${scopeSuffix}-s@test.local`;
    const studentS = await prisma.student.create({
      data: {
        firstName: 'Unlink',
        lastName: 'Student',
        email: studentSEmail,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: studentSEmail } },
      },
      select: { id: true },
    });
    studentSId = studentS.id;

    const studentS2 = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `${scopeSuffix}-s2@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    studentS2Id = studentS2.id;

    // Without this link `unlinkTeacher` returns NOT_LINKED before the pre-lock
    // runs at all — which the `toHaveLength(1)` assertion below is what catches.
    await prisma.teacherStudent.create({ data: { teacherId: teacherTId, studentId: studentSId } });

    await prisma.waitlistEntry.createMany({
      data: [
        { classId: classTId, studentId: studentSId, position: 1, status: 'waiting' },
        { classId: classT2Id, studentId: studentSId, position: 1, status: 'waiting' },
        { classId: classT3Id, studentId: studentS2Id, position: 1, status: 'waiting' },
      ],
    });
  });

  afterAll(async () => {
    const studentIds = [studentSId, studentS2Id];
    const teacherIds = [teacherTId, teacherT2Id];
    await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.room.deleteMany({ where: { id: scopeRoomId } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await prisma.account.deleteMany({ where: { id: { in: [teacherTAccountId, teacherT2AccountId] } } });
  });

  /** Same idiom as `gdpr.test.ts`'s, copied rather than shared — see this
   * describe's header and the fixture independence it rests on. */
  const captureLockSets = (): string[][] => {
    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());
    return lockSets;
  };

  it('withdraws only this pair’s entries, and locks only their classes', async () => {
    const lockSets = captureLockSets();

    const result = await unlinkTeacher(prisma, {
      teacherId: teacherTId,
      studentId: studentSId,
      accountEmail: studentSEmail,
    });

    // NOT_LINKED here would mean the pre-lock never ran and every assertion
    // below is about a call that did nothing.
    expect(result).toEqual({ ok: true });

    expect(lockSets).toHaveLength(1);
    expect(lockSets[0]).toEqual([classTId]);

    // The call did its job: S's standing request of T is withdrawn.
    const withdrawn = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classTId, studentId: studentSId },
    });
    expect(withdrawn.status).toBe('removed');

    // SUPERSEDED IN TASK 2 — kept here only so the diff that rewrote it makes
    // sense. The reachability is real and was measured: under mutation 3 this
    // row does flip to `removed`. "The witness" is what is wrong — the
    // lock-set assertion above throws first, so this line never executes under
    // that mutation. What shipped is in `waitlist.test.ts`.
    // DECOY 1 — the data-loss witness. S's request of ANOTHER teacher is not
    // this unlink's business, and a pre-lock missing `e."teacherId"` reaches it
    // because the `updateMany` is keyed on the ids this lock returned.
    const otherTeachersQueue = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classT2Id, studentId: studentSId },
    });
    expect(otherTeachersQueue.status).toBe('waiting');

    // SUPERSEDED IN THE FINAL REVIEW's FIX ROUND — kept here only so the diff
    // that rewrote it makes sense. "It guards that scope" claims more than the
    // line can do: dropping `studentId` from the `updateMany` leaves
    // `{ classId: { in: [classT] }, status: 'waiting' }`, and this row is on
    // `classT3`, which is not in the lock set. No single-fault mutation of the
    // write fails this assertion. What shipped is in `waitlist.test.ts`.
    // DECOY 2 — another student's request in T's own class. HONEST ABOUT WHAT
    // THIS CATCHES: it cannot fail on a widened pre-lock, since the
    // `updateMany` re-scopes on `studentId`. It guards that scope; the
    // `w."studentId"` conjunct is witnessed by the lock set above.
    const otherStudentsRequest = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classT3Id, studentId: studentS2Id },
    });
    expect(otherStudentsRequest.status).toBe('waiting');
  });
});
```

- [ ] **Step 3: Run the new test — expect PASS**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`

Expected: whole file passes. If `expect(result).toEqual({ ok: true })` fails with
`NOT_LINKED`, the `TeacherStudent` row is missing; if it throws from
`requireNormalised`, `accountEmail` is not lowercase.

- [ ] **Step 4: Commit before mutating**

```bash
git add src/services/waitlist.test.ts
git commit -m "test(waitlist): two decoys prove the withdrawal pre-lock is scoped to its pair (#453)"
```

- [ ] **Step 5: Mutation 3 — drop the teacher conjunct**

In `src/services/waitlist.ts:1094`, remove the first conjunct:

```ts
    where: Prisma.sql`w."studentId" = ${input.studentId}
      AND w.status = 'waiting'`,
```

Safe to run: the collateral write is scoped to `studentId`, which is this
fixture's own per-run-unique student.

- [ ] **Step 6: Run — expect RED on the lock set AND on decoy 1**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`

Expected: the new test fails — `lockSets[0]` contains `classT2Id`, and (whichever
assertion the runner reaches first) decoy 1's status has become `removed`.
Record the exact output. Both failures are the point: this is the conjunct whose
widening loses data.

**Corrected during Task 2 — the run cannot report both, so the step title is
wrong.** The lock-set assertion sits above decoy 1's and fails first: vitest
throws out of the test body and decoy 1's assertion never executes. The RED to
expect is the lock-set one alone, with `classT2Id` in the received array. The
data loss is real all the same, and was measured in the Task 2 review by
relaxing the lock-set assertion to `toContain` for one run — decoy 1's row came
back `'removed'` (`expected 'removed' to be 'waiting'`). That diagnostic is an
acceptable way to see the survival assertion execute; revert it immediately and
confirm `git diff` is empty.

- [ ] **Step 7: Restore, confirm green**

Reverse the Step 5 edit. Run the file again — expect PASS, and
`git diff src/services/waitlist.ts` empty.

- [ ] **Step 8: Mutation 4 — drop the student conjunct**

In `src/services/waitlist.ts:1095`, remove that conjunct:

```ts
    where: Prisma.sql`e."teacherId" = ${input.teacherId}
      AND w.status = 'waiting'`,
```

- [ ] **Step 9: Run — expect RED on the lock set ONLY**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`

Expected: the new test fails on `expect(lockSets[0]).toEqual([classTId])`, with
`classT3Id` also present.

**Corrected during Task 2 — this step originally said "the decoy-2 survival
assertion must still PASS ... this run is where it is checked".** It cannot be
checked that way: the lock-set assertion sits above it and fails first, so
vitest throws out of the test body and decoy 2's assertion never executes. Ask
instead for what is observable: record which assertion the runner reaches
first, and verify the asymmetry claim by reading the write predicate
(`waitlist.ts:1104` keys its `updateMany` on `input.studentId`, so the decoy's
row is unreachable however wide the lock set gets). A one-run diagnostic that
relaxes the lock-set assertion to `toContain` is an acceptable way to see the
survival assertions execute — revert it immediately and confirm `git diff` is
empty.

- [ ] **Step 10: Restore, confirm green**

Reverse the Step 8 edit. Run the file — expect PASS, `git diff` on
`src/services/waitlist.ts` empty. Nothing to commit.

---

### Task 3: `class-template-lifecycle.ts` — the archive pre-lock

Covers `e."scheduleRuleId"` (`class-template-lifecycle.ts:756`).

**Files:**
- Modify: `src/services/class-template-lifecycle.test.ts` — one new `it` inside
  the existing `describe('archiveOrUnarchiveTemplate (DB)', …)` (lines
  1104-2470), plus one import line

**Interfaces:**
- Consumes: the existing in-describe helpers `makeTemplate(classType)`,
  `makeClass(scheduleRuleId, { date, status? })`, `future()`, `expectArchived`,
  and the describe's `teacherId`; plus Task 1's `captureLockSets` idiom, copied.
- Produces: nothing.

**The decoy is a second rule of the SAME teacher.** A different teacher's class
would also be excluded by a rule-scoped predicate, but only incidentally — a
same-teacher, different-rule class is the row that isolates `e."scheduleRuleId"`
as the thing doing the narrowing. `makeTemplate` already spaces each new rule's
slot to satisfy `ScheduleRule_teacher_slot_excl`, so use it rather than
hand-rolling a rule.

- [ ] **Step 1: Add the import**

`src/services/class-template-lifecycle.test.ts:14` imports
`{ setLockTimeout } from '@/lib/db-locks'`. Leave it and add the namespace
import beside it — the spy needs the module object:

```ts
import * as dbLocks from '@/lib/db-locks';
```

Confirm `vi` and `onTestFinished` are in the file's `vitest` import; add them if
not.

- [ ] **Step 2: Add the test inside the archive describe**

Place it among the other `it`s in `describe('archiveOrUnarchiveTemplate (DB)')`,
so it closes over that block's `teacherId`, `makeTemplate`, `makeClass`,
`future()` and `expectArchived`.

```ts
  /**
   * The pre-lock's `e."scheduleRuleId"` conjunct, isolated by a SECOND RULE OF
   * THE SAME TEACHER.
   *
   * Only the lock set can witness this one. Dropping the conjunct changes no
   * written row: the delete re-derives its own scope through
   * `family.deleteWhere(scheduleRuleId, today)` (`rule-lifecycle.ts`), the
   * notification candidate read re-scopes independently, and so does
   * `remaining` — so a rule-unscoped pre-lock deletes, cancels and notifies
   * exactly the same rows. Its only other symptom is contention: `FOR UPDATE`
   * on every future scheduled class in the database, colliding intermittently
   * with whatever else the parallel tier is running and swallowed into
   * `{ ok: false, reason: 'busy' }`. That is a flake, not a guard.
   *
   * This describe leaves earlier tests' classes standing (there is no per-test
   * cleanup), so a foreign-rule class is often present here by accident. The
   * decoy is built explicitly anyway: an assertion resting on a neighbour
   * test's leftovers is the defect #453 is about.
   */
  it('locks only the archived rule’s own classes', async () => {
    const t = await makeTemplate('Scope Under Test');
    const c = await makeClass(t.scheduleRuleId, { date: future() });

    const decoyTemplate = await makeTemplate('Scope Decoy');
    const decoyClass = await makeClass(decoyTemplate.scheduleRuleId, { date: future() });

    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());

    const result = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    // The archive ran and reached its own class — without this the assertions
    // below are about a call that withdrew nothing.
    expect(result.deleted).toBe(1);
    expect(lockSets).toHaveLength(1);
    expect(lockSets[0]).toEqual([c.id]);

    // The decoy rule's class survives. HONEST ABOUT WHAT THIS CATCHES: it
    // cannot fail on a widened pre-lock (the delete re-scopes itself); it
    // guards `deleteWhere`'s own `scheduleRuleId` scope, a different
    // regression.
    expect(await prisma.class.count({ where: { id: decoyClass.id } })).toBe(1);
  });
```

- [ ] **Step 3: Run the file — expect PASS**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`

Expected: whole file passes. Two fixture-shaped failures to watch for: a
`ScheduleRule_teacher_slot_excl` refusal (means the rule was hand-rolled instead
of going through `makeTemplate`), and `lockSets` length 0 (means the archive
short-circuited before the pre-lock — check `result.deleted`).

- [ ] **Step 4: Commit before mutating**

```bash
git add src/services/class-template-lifecycle.test.ts
git commit -m "test(class-template-lifecycle): a same-teacher decoy rule proves the archive pre-lock is rule-scoped (#453)"
```

- [ ] **Step 5: Mutation 5 — drop the rule conjunct**

In `src/services/class-template-lifecycle.ts:756`, remove the first conjunct:

```ts
        where: Prisma.sql`e."cancelledAt" IS NULL
          AND e.date > ${today}
          AND c.status IN (${SCHEDULED_STATUSES_SQL})`,
```

Safe to run — it widens the lock set and writes nothing extra.

- [ ] **Step 6: Run — expect RED on the lock set only**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`

Expected: the new test fails on `expect(lockSets[0]).toEqual([c.id])`, with
`decoyClass.id` present (and possibly other future scheduled classes from
earlier tests in this describe — record them; their presence is the accidental
coverage this decoy replaces with a deliberate one).

**Do NOT expect the `class.count` survival assertion to report anything.** Task
2 established the general rule: the lock-set assertion sits above it and fails
first, so the survival assertion never executes under a pre-lock widening. It is
not the witness here and never was — it pins `deleteWhere`'s own
`scheduleRuleId` scope, a different mutation class. Record which assertion the
runner reaches first, and leave it at that.

Other tests in this file may also redden under this mutation, from contention
or from a wider lock. That is fine and worth recording, but it is not the
evidence — the named assertion in the new test is.

- [ ] **Step 7: Restore, confirm green**

Reverse the Step 5 edit. Run the file — expect PASS, and
`git diff src/services/class-template-lifecycle.ts` empty.

---

### Task 4: Whole-branch verification

**Files:** none modified unless a defect is found.

- [ ] **Step 1: Confirm no production file changed**

```bash
git diff main --stat
```

Expected: exactly three `*.test.ts` files, plus the spec and this plan. Any
`src/**/*.ts` that is not a test file means a mutation was left in place.

- [ ] **Step 2: Full verify**

Run: `npm run verify`

Expected: green — typecheck, lint, and every vitest project. Record the test
counts per project so the PR body can show the arithmetic. If anything earlier
in the chain is red, run `npx vitest run --project integration` directly rather
than reading a red `verify` as evidence about that tier: `npm test` chains two
invocations with `&&`, so one red unit test means `integration` reports nothing
at all, not zero failures.

- [ ] **Step 3: Push and open the PR**

The PR body must carry: the five-conjunct asymmetry table; the measured
mutation evidence per conjunct with its exact assertion output; the correction
to the issue's acceptance criterion (the "never touched at all" form is
impossible at three of five); the collateral row(s) cancelled by mutation 1 and
the fact that they cannot be restored; and the `verify` arithmetic. Write it to
a file and pass `--body-file` — backticks in a `--body "…"` string reach zsh as
command substitution and fail silently.

## Self-Review

**Spec coverage.** Every spec section maps to a task: §A → Task 1 (both
conjuncts, both tests, order stated), §B → Task 2 (two decoys, `unlinkTeacher`
rationale, both preconditions), §C → Task 3 (same-teacher decoy rule,
`makeTemplate` slot spacing). §Verification's five-mutation matrix is spread
across Tasks 1, 2 and 3 as explicit steps, one per conjunct, each with restore
and re-verify. §"Not in scope" is enforced by the Global Constraints and by Task
4 Step 1.

**One deliberate refinement to the spec.** §C says section C carries no survival
assertion, on the grounds that the decoy survives either way. Task 3 includes
one anyway — one line, labelled with what it cannot catch — because it guards
`deleteWhere`'s own `scheduleRuleId` scope, which is a real and different
regression, and because Tasks 1 and 2 both carry the same kind of honestly
labelled assertion. Consistency across the three blocks is worth more than the
spec's original economy here. The spec has been updated to match.

**Placeholder scan.** No TBD/TODO. Every code step carries real code; every run
step carries a command and an expected result.

**Type consistency.** `captureLockSets(): string[][]` has the same signature in
Tasks 1 and 2; Task 3 inlines the same body (one test needs it, so a helper
would be indirection). `dbLocks.lockClassRowsOrdered`'s
`(tx, source) => Promise<string[]>` shape is used identically in all three, and
matches the existing spy at `gdpr.test.ts:3144`.
