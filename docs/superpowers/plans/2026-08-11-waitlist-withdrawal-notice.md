# Telling waitlisted students their class is gone (#112) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A student waiting for a class is told when that class stops being offered, by every path that stops offering it — and no waiting entry is left pointing at a class that is gone or cancelled.

**Architecture:** Three production paths change, each inside a transaction that already exists. Auto-cancel (`class-transitions.ts`) and teacher erasure (`gdpr.ts`) concatenate waiting students into the `CreateNotificationInput[]` they already build. Archive (`class-template-lifecycle.ts`) cannot do that, because its recipients are cascade-deleted by the very statement that removes the class — so it reads candidates before the delete and filters them against what the delete actually took, leaving the delete statement itself untouched. No schema change, no migration.

**Tech Stack:** TypeScript strict, Prisma/PostgreSQL, Vitest (`unit` project, dedicated test database), existing `createBulkNotifications` bulk-insert helper.

**Spec:** `docs/superpowers/specs/2026-08-11-waitlist-withdrawal-notice-design.md` — read it before Task 1. The reachability argument in it is what justifies every fixture below.

## Global Constraints

- **The archive `deleteMany` at `class-template-lifecycle.ts:693` is not to be modified.** #86's comment at `:683-692` forbids turning it back into a read-then-delete; the exactness in Task 4 comes from a read *after* it, never from constraining it.
- **The deletion rule is unchanged.** A waiting entry does not spare a class from archiving. Only the silence is being fixed.
- **`removed` is the existing terminal status** for a waiting entry whose class went away — used by `removeFromWaitlist`, `transition/route.ts:52`, and `gdpr.ts:736`. Do not invent a new status.
- **`class_cancelled` is the notification type on every path.** It is in `ESSENTIAL_NOTIFICATION_TYPES` (`notification-policy.ts:16`), so delivery bypasses `Student.emailNotifications`. Title is `'Class cancelled'` everywhere, matching all three existing sites.
- **Never start or restart the dev server on :3000.** The user runs it.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `"src/app/api/classes/[id]/transition/route.ts"`.
- **Unit tests run against the dedicated test database** (`DATABASE_URL_TEST`), with `TZ=America/New_York` pinned at the vitest root. Run a single file with `npx vitest run --project unit <path>`.
- **Every guard gets broken and shown to fail.** Each task carries its own mutation step with the exact error text recorded. A guard that compiles and cannot fail certifies nothing.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/class-transitions.ts` | auto-cancel sweep | read waiting entries, close them, notify (Task 2) |
| `src/services/gdpr.ts` | teacher erasure | notify waiters; fix the empty-list guard (Task 3) — the `removed` update already exists at `:736` |
| `src/services/class-template-lifecycle.ts` | template archive | candidates → delete (untouched) → survivors → notify (Task 4) |
| `src/services/class-transitions.test.ts` | auto-cancel tests | new frozen-window fixture + third student (Task 2) |
| `src/services/gdpr.test.ts` | erasure tests | queue-only erasure test (Task 3) |
| `src/services/class-template-lifecycle.test.ts` | archive tests | cascade pin (Task 1), notify + spared tests (Task 4), concurrency test (Task 5) |

**Task order is load-bearing in one place:** Task 5 tests the survivor filter that Task 4 introduces, so it must follow it. Tasks 1, 2 and 3 are independent of each other and of 4.

---

### Task 1: Pin the cascade #86 asked for and never got

`docs/superpowers/specs/2026-07-25-template-archive-withdraws-window-design.md:231` asked for an explicit test of the `WaitlistEntry` cascade, on the grounds that a later migration could change it without anyone revisiting that file. It was never written — `class-template-lifecycle.test.ts` contains zero occurrences of `waitlist`. Everything in Task 4 rests on this cascade, so it gets pinned first and independently.

**Files:**
- Test: `src/services/class-template-lifecycle.test.ts` (archive describe block, after the `keeps a future class with a late_cancel registration` test at `:505-521`)

**Interfaces:**
- Consumes: `makeTemplate(classType)`, `makeClass(templateId, {date, status?})`, `future()`, `studentId` — all already in that describe block.
- Produces: nothing. Test-only task.

- [ ] **Step 1: Write the failing test**

Insert after the `late_cancel` test (`:521`):

```ts
  /**
   * #86 (`2026-07-25-template-archive-withdraws-window-design.md:231`) asked
   * for this and it was never written. The archive path's whole notification
   * design (#112) rests on the cascade being real: it notifies BEFORE the
   * delete precisely because these rows do not survive it. A migration that
   * changed `onDelete` would silently turn that ordering from necessary into
   * merely early, and nothing else in the suite would notice.
   */
  it('cascade-deletes waitlist entries when the class row goes', async () => {
    const t = await makeTemplate('Cascade Pin');
    const c = await makeClass(t.id, { date: future() });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId, position: 1, status: 'waiting' },
    });

    // Delete the class directly rather than through archiving: this pins the
    // schema property itself, not the one caller that happens to rely on it.
    await prisma.class.delete({ where: { id: c.id } });

    expect(await prisma.waitlistEntry.count({ where: { id: entry.id } })).toBe(0);
  });
```

- [ ] **Step 2: Run it and confirm it passes against today's schema**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t 'cascade-deletes waitlist entries'
```

Expected: PASS. This one is a pin on existing behaviour, so passing first is correct — which is exactly why Step 3 is not optional.

- [ ] **Step 3: Prove it can fail — mutate the FK on the test database**

Prisma cannot express this mutation without a migration, and applied migrations are never edited. Mutate the constraint directly on the **test** database instead (`DATABASE_URL_TEST`), which is the database the `unit` project talks to:

```bash
# Confirm the current rule first, and the constraint's exact name.
docker exec fairyoga-db-1 psql -U postgres -d fairyoga_test -c \
  '\d "WaitlistEntry"' | grep -i "foreign key"

docker exec fairyoga-db-1 psql -U postgres -d fairyoga_test -c \
  'ALTER TABLE "WaitlistEntry" DROP CONSTRAINT "WaitlistEntry_classId_fkey";
   ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_classId_fkey"
     FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT;'
```

Re-run the test. Expected: FAIL. `RESTRICT` makes `prisma.class.delete` raise a foreign-key violation, so the failure surfaces at the delete rather than at the assertion:

```
PrismaClientKnownRequestError: Foreign key constraint violated on the constraint: `WaitlistEntry_classId_fkey`
```

Record the exact text you observe in the commit message.

`RESTRICT`, not `SetNull`: `WaitlistEntry.classId` is non-nullable, so `SetNull` is not a legal mutation here — it fails at DDL time and would prove nothing about the test.

- [ ] **Step 4: Restore the constraint and re-verify**

```bash
docker exec fairyoga-db-1 psql -U postgres -d fairyoga_test -c \
  'ALTER TABLE "WaitlistEntry" DROP CONSTRAINT "WaitlistEntry_classId_fkey";
   ALTER TABLE "WaitlistEntry" ADD CONSTRAINT "WaitlistEntry_classId_fkey"
     FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE;'

docker exec fairyoga-db-1 psql -U postgres -d fairyoga_test -c '\d "WaitlistEntry"' | grep -i "foreign key"
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Expected: the constraint reads `ON DELETE CASCADE` again, and the whole file passes. Do not proceed with a mutated test database.

- [ ] **Step 5: Commit**

```bash
git add src/services/class-template-lifecycle.test.ts
git commit -m "test: the cascade #86 asked to pin, two years of migrations later"
```

---

### Task 2: Auto-cancel tells the queue, and closes it

`autoCancelClasses` builds its recipient list from `tx.registration.findMany` alone (`class-transitions.ts:287`) and never reads `waitlistEntry` — the file contains zero references to that model. The issue offered this function as the example of getting it right; it has the same bug.

**Files:**
- Modify: `src/services/class-transitions.ts:287-312`
- Test: `src/services/class-transitions.test.ts` (shared `describe` block: a third student in `beforeAll`/`afterAll`, then a new test after the existing auto-cancel tests at `:186`)

**Interfaces:**
- Consumes: `createBulkNotifications`, `CreateNotificationInput` — both already imported at the top of `class-transitions.ts`.
- Produces: no new exports. `autoCancelClasses(db, now)` keeps its signature and its `Promise<number>` return.

- [ ] **Step 1: Add the third student to the shared fixture**

The file's own comment at `:69-77` requires fixtures to be hoisted into `beforeAll` so the shared `afterAll` reaps them even when a test fails mid-way. Follow it.

In the `let` block at `:20-24`, add:

```ts
  let waiterStudentId: string;
```

At the end of `beforeAll` (after `secondStudentId = secondStudent.id;` at `:86`):

```ts
    // #112. A third student, never registered, only ever queued — the whole
    // point is that a waiting entry is a person the recipient list cannot see
    // by reading registrations. Hoisted for the same reason the second one is.
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Tz',
        lastName: 'Waiter',
        email: `tz-waiter-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    waiterStudentId = waiter.id;
```

In `afterAll`, add `waiterStudentId` to all three id lists (`:91`, `:94`, `:96`, `:100`) so the notification, registration and student rows are reaped:

```ts
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [teacherId, studentId, secondStudentId, waiterStudentId] } },
    });
    await prisma.payment.deleteMany({
      where: { registration: { studentId: { in: [studentId, secondStudentId, waiterStudentId] } } },
    });
    await prisma.registration.deleteMany({
      where: { studentId: { in: [studentId, secondStudentId, waiterStudentId] } },
    });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.deleteMany({
      where: { id: { in: [studentId, secondStudentId, waiterStudentId] } },
    });
```

- [ ] **Step 2: Write the failing test**

Add `getWaitlistWindow` to the imports at the top of the file:

```ts
import { getWaitlistWindow } from './waitlist';
```

Insert after the `does not auto-cancel before the local check window opens` test (`:186`):

```ts
  /**
   * #112. The fixture's timing is the test, not scenery.
   *
   * A waitlist only forms at `maxStudents`, and `handleSpotFreed` refills the
   * seat it just lost — so a class carrying a queue normally has its count
   * PINNED at max, and the queue drains to empty before the count can fall far
   * enough to auto-cancel. The one thing that suspends that drain is the
   * freeze, and auto-cancel can only ever run inside it: `DEADLINE_HOURS`
   * bottoms out at 6 (`waitlist.ts:96`) and `CANCEL_CHECK_HOURS` tops out at 4
   * (`class-transitions.ts:21`), so across all 12 configurations the sweep runs
   * strictly after the freeze, with two hours to spare.
   *
   * Constructing a below-minimum class with a waiting entry at some arbitrary
   * `now` would therefore pin a state production cannot reach, and would pass
   * without exercising the mechanism at all. Hence the explicit window
   * assertion below — it fails loudly if a later edit moves the clock out of
   * the frozen window and quietly turns this into that weaker test.
   *
   * What makes the count fall is the status asymmetry: `late_cancel` is in
   * `CHARGED_STATUSES` (`class-lifecycle.ts:167`) but not in
   * `ACTIVE_REGISTRATION_STATUSES` (`class-transitions.ts:34`), which is what
   * the sweep counts by. The seat is released; the registration stays billable.
   */
  it('tells the waitlist when it auto-cancels, and closes the queue', async () => {
    const cls = await makeClass({
      minStudents: 2,
      maxStudents: 2,
      autoCancelCheck: 'HOURS_2',
      cancelDeadline: 'HOURS_24',
    });
    // Full at 2/2 when the queue formed; one seat later released by a
    // late-cancel, which nothing promoted into because the window is frozen.
    await prisma.registration.create({
      data: { classId: cls.id, studentId, tierAtBooking: 3, status: 'registered' },
    });
    await prisma.registration.create({
      data: {
        classId: cls.id,
        studentId: secondStudentId,
        tierAtBooking: 3,
        status: 'late_cancel',
        cancelledAt: new Date('2026-07-20T10:00:00Z'),
      },
    });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiterStudentId, position: 1, status: 'waiting' },
    });

    // 15:00Z is inside the HOURS_2 check window (14:00Z–16:00Z) AND past the
    // HOURS_24 deadline (2026-07-19T16:00Z). Assert the second half rather
    // than trusting the arithmetic.
    const at = new Date('2026-07-20T15:00:00Z');
    expect(
      getWaitlistWindow(cls.date, cls.startTime, cls.cancelDeadline, 'Europe/Amsterdam', at),
    ).toBe('frozen');

    await autoCancelClasses(prisma, at);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('cancelled');

    const waiterNote = await prisma.notification.findFirst({
      where: {
        recipientType: 'student',
        recipientId: waiterStudentId,
        relatedClassId: cls.id,
        type: 'class_cancelled',
      },
    });
    expect(waiterNote).not.toBeNull();

    // The entry must not be left pointing at a cancelled class.
    const afterEntry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(afterEntry.status).toBe('removed');

    await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.class.delete({ where: { id: cls.id } });
  });
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run --project unit src/services/class-transitions.test.ts -t 'tells the waitlist when it auto-cancels'
```

Expected: FAIL at `expect(waiterNote).not.toBeNull()` with `AssertionError: expected null not to be null`. The class does cancel and the window assertion does pass — only the notification is missing. If it fails at the window assertion instead, the fixture is wrong, not the code.

- [ ] **Step 4: Implement**

In `src/services/class-transitions.ts`, replace lines `287-303` (the `registrations` read and the `notifications` map) with:

```ts
        const registrations = await tx.registration.findMany({
          where: { classId: cls.id, status: { in: ACTIVE_REGISTRATION_STATUSES } },
          select: { studentId: true },
        });

        // #112. Read before the update below closes them — `updateMany`
        // returns a count, not rows, so the recipient list has to be taken
        // first. A student in this queue was told the class was full and has
        // been waiting for a seat; the class not happening at all is the one
        // outcome they most need to hear about, and until now this sweep was
        // the only cancellation path that never told them. The manual-cancel
        // route (`transition/route.ts:47-58`) is the shape being copied.
        const waiting = await tx.waitlistEntry.findMany({
          where: { classId: cls.id, status: 'waiting' },
          select: { studentId: true },
        });
        if (waiting.length > 0) {
          await tx.waitlistEntry.updateMany({
            where: { classId: cls.id, status: 'waiting' },
            data: { status: 'removed' },
          });
        }

        // Bodies built from `fresh`, not `cls`. A notice that names the
        // pre-lock `classType` or `minStudents` tells the student about a
        // class that no longer exists in that shape — the same defect as
        // deciding from the snapshot, one step later and harder to see.
        //
        // One body for both audiences, like the manual-cancel route: a
        // waitlisted student never held a spot, but "this class is cancelled"
        // is true for both, and two bodies would be two things to keep in step.
        const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
          recipientType: 'student' as const,
          recipientId: r.studentId,
          type: 'class_cancelled' as const,
          title: 'Class cancelled',
          body: `${fresh.classType} class has been cancelled due to insufficient registrations.`,
          relatedClassId: cls.id,
        }));
```

Leave the teacher notification `push` at `:304-311` and the `createBulkNotifications` call exactly as they are.

- [ ] **Step 5: Run the whole file**

```bash
npx vitest run --project unit src/services/class-transitions.test.ts
```

Expected: PASS, every test. The existing auto-cancel tests have no waitlist entries, so `waiting` is empty and their recipient lists are unchanged.

- [ ] **Step 6: Prove both guards bite**

Two guards, two mutations, run one at a time:

1. **The waitlist read.** Delete the `waiting` findMany and drop `...waiting` from the spread. Re-run → the new test must FAIL at `expect(waiterNote).not.toBeNull()`. Restore.
2. **The `removed` update.** Delete the `if (waiting.length > 0) { … updateMany … }` block. Re-run → the new test must FAIL at `expect(afterEntry.status).toBe('removed')` with `expected 'waiting' to be 'removed'`. Restore.

Record both error texts. Re-run the file clean afterwards.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-transitions.ts src/services/class-transitions.test.ts
git commit -m "fix: auto-cancel told everyone but the people waiting for a seat"
```

---

### Task 3: Teacher erasure tells the queue it is already closing

This path is **half-fixed already**, which the spec's first draft got wrong: `gdpr.ts:736` runs `waitlistEntry.updateMany(waiting → removed)` right after the CAS. The entries are closed correctly; the students are simply never told. So this task adds no status write — it adds a read, a concatenation, and one guard fix.

The trap: `gdpr.ts:761` gates the whole notification build behind `if (registrations.length > 0)`. A class whose only audience is its queue has zero registrations, so leaving that guard keyed on the registration list silently drops exactly the notification being added.

**Files:**
- Modify: `src/services/gdpr.ts:736-771`
- Test: `src/services/gdpr.test.ts` (new test in the `deleteTeacherAccount` area, using the existing `makeStudentWaitingInClass` / `cleanupStudentWaitingInClass` fixture pair)

**Interfaces:**
- Consumes: `createBulkNotifications`, `CreateNotificationInput` (already imported in `gdpr.ts`); `makeStudentWaitingInClass({ waiting, registered })` and `cleanupStudentWaitingInClass(fixture)` from the test file — the fixture returns `{ studentId, classId, teacherId, roomId, accountId, registrationId }`.
- Produces: no signature change to `deleteTeacherAccount(db, teacherId)`.

- [ ] **Step 1: Write the failing test**

Add near the other `deleteTeacherAccount` tests (the fixture-based ones live around `:317-430`):

```ts
  /**
   * #112. `waiting: true, registered: false` is the load-bearing shape: a
   * class whose ONLY audience is its queue. `gdpr.ts` already closes these
   * entries (`:736`) but built its recipient list from registrations alone,
   * and gated the whole build behind `if (registrations.length > 0)` — so
   * this exact fixture is the one that catches both halves. A fixture with a
   * registered student too would pass against the unfixed guard, because the
   * build would run for the registered student and the waiter would ride
   * along on the concatenation.
   */
  it('tells a queued student when the teacher erases their account, with nobody registered', async () => {
    const fixture = await makeStudentWaitingInClass({ waiting: true, registered: false });
    try {
      await deleteTeacherAccount(prisma, fixture.teacherId);

      const note = await prisma.notification.findFirst({
        where: {
          recipientType: 'student',
          recipientId: fixture.studentId,
          relatedClassId: fixture.classId,
          type: 'class_cancelled',
        },
      });
      expect(note).not.toBeNull();

      const entry = await prisma.waitlistEntry.findFirstOrThrow({
        where: { classId: fixture.classId, studentId: fixture.studentId },
      });
      expect(entry.status).toBe('removed');
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: fixture.studentId } });
      await cleanupStudentWaitingInClass(fixture);
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/services/gdpr.test.ts -t 'tells a queued student when the teacher erases'
```

Expected: FAIL at `expect(note).not.toBeNull()` — `AssertionError: expected null not to be null`. The `expect(entry.status).toBe('removed')` assertion passes even before the fix, because `gdpr.ts:736` already does that; that is the point of asserting it here rather than assuming it.

- [ ] **Step 3: Implement**

In `src/services/gdpr.ts`, replace the `updateMany` at `:736-739` with a read-then-update pair:

```ts
        // #112. Read before closing them: `updateMany` returns a count, not
        // rows, and these students are recipients. The update itself is
        // unchanged — this path has always closed the queue correctly and has
        // simply never told anyone it had.
        const waiting = await tx.waitlistEntry.findMany({
          where: { classId: cls.id, status: 'waiting' },
          select: { studentId: true },
        });
        await tx.waitlistEntry.updateMany({
          where: { classId: cls.id, status: 'waiting' },
          data: { status: 'removed' },
        });
```

Then replace `:761-771` (the guarded notification build) with:

```ts
        // Guard on the CONCATENATED list, not on `registrations`. A class
        // whose only audience is its queue has no registrations at all, and
        // that is precisely the case #112 exists to cover — keying this on
        // `registrations.length` drops the notification for exactly the
        // student it was added for, and every fixture with both audiences
        // passes anyway.
        const recipients = [...registrations, ...waiting];
        if (recipients.length > 0) {
          const notifications: CreateNotificationInput[] = recipients.map((r) => ({
            recipientType: 'student' as const,
            recipientId: r.studentId,
            type: 'class_cancelled' as const,
            title: 'Class cancelled',
            body: `${cls.classType} has been cancelled — the teacher closed their account.`,
            relatedClassId: cls.id,
          }));
          await createBulkNotifications(tx, notifications);
        }
```

Leave the CAS-refused `continue` branch at `:704-734` untouched. It skips the waitlist sweep deliberately and logs the residual as `waitingEntriesLeft`; a half-applied skip would tell a student their class was cancelled after `completeClass` had already billed them for it.

- [ ] **Step 4: Run the whole file**

```bash
npx vitest run --project unit src/services/gdpr.test.ts
```

Expected: PASS, every test.

- [ ] **Step 5: Prove all three guards bite**

One at a time, restoring between each:

1. **The waitlist read / concatenation.** Change `recipients` back to `registrations`. Re-run → the new test FAILS on the null notification.
2. **The empty-list guard.** Change the condition back to `if (registrations.length > 0)`, keeping the concatenated map. Re-run → the new test FAILS on the null notification. This is the mutation that a both-audiences fixture would have missed.
3. **The pre-existing `removed` update.** Delete the `updateMany`. Re-run → the new test FAILS at `expect(entry.status).toBe('removed')`. This pins behaviour that already works, so it must be shown to fail too, or it is an assertion of nothing.

Record each error text.

- [ ] **Step 6: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "fix: erasure closed the queue and never said a word to it"
```

---

### Task 4: Archive notifies, filtered by what the delete actually took

The hard path. The recipients are cascade-deleted by the statement that removes the class, so the read has to come first — but a booking committing between the read and the delete spares that class, and notifying from the read alone would tell a student their class was withdrawn while their entry is still `waiting` and the class is still on the teacher's page. So: read candidates, delete (untouched), read back who survived, notify the difference.

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` — insert after `:681`, and again after `:698`
- Test: `src/services/class-template-lifecycle.test.ts` (archive describe block)

**Interfaces:**
- Consumes: `scheduledWhere(templateId, date)` (`:397`), `CHARGED_STATUSES` (already imported), `startOfLocalDay` (already imported).
- Produces: no change to `archiveOrUnarchiveTemplate`'s signature or to `ArchiveTemplateResult`. `deleted` and `remaining` keep their meanings — the notification count is deliberately **not** added to the result, per the spec's out-of-scope list.
- New imports needed in `class-template-lifecycle.ts`:
  ```ts
  import { createBulkNotifications, type CreateNotificationInput } from './notifications';
  import { formatDateShort } from '@/lib/format';
  ```
  `@/lib/format` is safe to import here: its only import is `import type { PaymentStatus }`, which erases. It is not `@/lib/log`.

- [ ] **Step 1: Add a second student and notification cleanup to the archive block's fixtures**

The block has one student (`:411-418`). The spared-class test needs a registrant and a waiter who are different people. Add to the `let` declarations near `:328`:

```ts
  let waiterId: string;
```

At the end of that block's `beforeAll` (after `studentId = student.id;` at `:418`):

```ts
    // #112. A second student who only ever waits — the spared-class test needs
    // a registrant and a waiter who are different people, or "the waiter was
    // not notified" is indistinguishable from "the registrant was not".
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Waiter',
        email: `archive-waiter-${uniqueSuffix}@test.local`,
      },
    });
    waiterId = waiter.id;
```

In that block's `afterAll`, replace the single student delete at `:422` with:

```ts
    // Archive notifications outlive their class: `Notification.relatedClass`
    // is `onDelete: SetNull` (`schema.prisma:563`), so the class deletes below
    // do NOT reap them. Delete by recipient, before the students go.
    await prisma.notification.deleteMany({ where: { recipientId: { in: [studentId, waiterId] } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: [studentId, waiterId] } } });
    await prisma.registration.deleteMany({ where: { studentId: { in: [studentId, waiterId] } } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, waiterId] } } });
```

- [ ] **Step 2: Write the two failing tests**

Add `formatDateShort` to the test file's imports, so the body assertion is
derived from the same helper the service uses rather than hard-coding a date
that goes stale:

```ts
import { formatDateShort } from '@/lib/format';
```

Then add after the cascade pin from Task 1:

```ts
  /**
   * #112. The archive's recipients are destroyed by the same statement that
   * makes them recipients, so the notification has to be built before the
   * delete — and `Notification.relatedClass` being `SetNull` means it survives
   * with a null link. The body therefore has to name the class itself; a
   * student opening their inbox has nothing else left to identify it by.
   */
  it('tells a waiting student when archiving withdraws their class', async () => {
    const t = await makeTemplate('Withdraw Notice');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'cancelled'); // not charged — class is deletable
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
    expect(result.deleted).toBe(1);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);

    const note = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'student', recipientId: waiterId, type: 'class_cancelled' },
    });
    // The link is gone with the class; the body is the only durable record,
    // so it has to carry all three identifying fields. Derived from the
    // fixture rather than hard-coded — a literal '16 Aug' would rot in five
    // days, since `future()` is relative to the run.
    expect(note.relatedClassId).toBeNull();
    expect(note.body).toContain('Withdraw Notice');
    expect(note.body).toContain(formatDateShort(c.date));
    expect(note.body).toContain('09:00'); // makeClass's startTime
  });

  /**
   * The complement, and the more important of the two: a class the delete
   * SPARED must not generate a notice. Without this, notifying straight from
   * the candidate read passes the test above and quietly lies to every student
   * whose class survived.
   */
  it('does not tell a waiting student when the class was spared', async () => {
    const t = await makeTemplate('Spared Notice');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'registered'); // charged — class survives
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
    expect(result.deleted).toBe(0);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);

    expect(
      await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
    ).toBe(0);
    // And the entry is untouched — the class is still on, the queue with it.
    const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { classId: c.id } });
    expect(entry.status).toBe('waiting');
  });
```

Note both tests query notifications by `recipientId: waiterId` without a class link, because after a withdrawal there is no class link left to query by. That is why `waiterId` is a student of its own: it keeps the two tests from seeing each other's rows.

- [ ] **Step 3: Run them and watch the first fail**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t 'waiting student'
```

Expected: `tells a waiting student…` FAILS at `findFirstOrThrow` with `NotFoundError: No Notification found`. `does not tell a waiting student…` PASSES already (nothing notifies anyone yet) — it is a regression guard for Step 4, not a red test.

- [ ] **Step 4: Implement — candidates, then survivors**

In `src/services/class-template-lifecycle.ts`, insert immediately after `const today = startOfLocalDay(now, timeZone);` (`:681`), before the `deleteMany`:

```ts
      // #112. Who is waiting on a class this archive is about to withdraw.
      //
      // Read BEFORE the delete because `WaitlistEntry.class` is
      // `onDelete: Cascade` (`schema.prisma:517`) — after the delete these
      // rows do not exist to be read. Filtered AFTER it (below) because this
      // read is not the delete's own evaluation: a registration can commit in
      // between and spare a class, and locking the candidates would not close
      // that window — `registrations/route.ts` never calls `lockClassRow`, and
      // its only class-row write (`settingsLocked: true`, `:195`) is skipped
      // when the row is already locked, which it always is here.
      //
      // The predicate mirrors the delete's exactly. It is allowed to drift
      // pessimistically (name a class the delete spares) because step three
      // catches that; it must never drift optimistically.
      const candidates = await tx.waitlistEntry.findMany({
        where: {
          status: 'waiting',
          class: {
            ...scheduledWhere(templateId, { gt: today }),
            registrations: { none: { status: { in: [...CHARGED_STATUSES] } } },
          },
        },
        select: {
          studentId: true,
          classId: true,
          // Type, date AND time: the notification outlives the class row with
          // a null link, so these three fields are the only identity it will
          // ever have. A student with two weekly classes needs the time.
          class: { select: { classType: true, date: true, startTime: true } },
        },
      });
```

Then insert immediately after the `deleteMany` block ends (`:698`), before the `remaining` count:

```ts
      // Which candidates' classes actually went. `deleteMany` returns a count,
      // not ids, and its predicate was re-evaluated at execution time — so
      // this read, not the candidate read, is what says who was withdrawn.
      //
      // Notifying from `candidates` alone would be simpler and wrong: a
      // booking landing between the two statements spares that class, and its
      // waiter would be told the class was withdrawn while their entry is
      // still `waiting` and the class is still open on the teacher's page — a
      // message the app itself contradicts.
      if (candidates.length > 0) {
        const survivors = await tx.class.findMany({
          where: { id: { in: candidates.map((c) => c.classId) } },
          select: { id: true },
        });
        const survived = new Set(survivors.map((s) => s.id));
        const withdrawn = candidates.filter((c) => !survived.has(c.classId));

        if (withdrawn.length > 0) {
          // No `relatedClassId`: the row is gone and the FK is `SetNull`
          // (`schema.prisma:563`), so the notification outlives its class with
          // a null link. The body has to name the class or the student is left
          // with an inbox entry they cannot place.
          const notifications: CreateNotificationInput[] = withdrawn.map((c) => ({
            recipientType: 'student' as const,
            recipientId: c.studentId,
            type: 'class_cancelled' as const,
            title: 'Class cancelled',
            body: `The ${c.class.classType} class on ${formatDateShort(c.class.date)} at ${c.class.startTime} has been withdrawn by your teacher. You were on its waiting list.`,
          }));
          await createBulkNotifications(tx, notifications);
        }
      }
```

The `deleteMany` between them is not edited. Confirm with `git diff` that lines `683-698` are untouched.

- [ ] **Step 5: Run the whole file**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Expected: PASS, every test — including the two from Steps 2, the cascade pin from Task 1, and the existing `deleted`/`remaining` count assertions, which this change does not touch.

- [ ] **Step 6: Prove the candidate read bites**

Delete the `candidates` findMany and the whole notification block. Re-run → `tells a waiting student…` FAILS at `findFirstOrThrow` with `NotFoundError: No Notification found`. Restore and re-verify.

The survivor filter is **not** provable here — with no concurrency, `withdrawn` and `candidates` are identical and removing the filter changes nothing. That is Task 5, and it is the reason Task 5 exists.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts
git commit -m "feat: archiving tells the students it was quietly deleting"
```

---

### Task 5: Make the survivor filter able to fail

Task 4's survivor filter is currently a guard that compiles and cannot fail — #39 shipped three of those, all caught only at PR review. It needs real concurrency: a registration that commits *outside* the archive transaction, between the candidate read and the delete.

This is testable because the archive transaction holds a row lock on the **template**, not on the candidate classes, so an outside write to `Registration` commits freely. Under READ COMMITTED the `deleteMany` re-evaluates its predicate at execution time, sees the now-charged registration, and spares the class — which is exactly the behaviour #86's single-statement delete exists to produce.

**Files:**
- Test: `src/services/class-template-lifecycle.test.ts` (archive describe block, after Task 4's tests)

**Interfaces:**
- Consumes: `archiveOrUnarchiveTemplate`, the block's `makeTemplate` / `makeClass` / `register` / `expectArchived`, and `waiterId` from Task 4 Step 1.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

The interposition pattern already exists in this file at `:224` — `prisma.$extends({ query: … })` with the same cast, for the same reason (the extended client lacks `$on`, so it is not assignable to a `PrismaClient`-typed parameter). Follow it exactly.

```ts
  /**
   * #112. The one guard in this change that needs real concurrency to bite.
   *
   * Without this test, notifying from the candidate read and notifying from
   * the survivor filter are indistinguishable — every non-concurrent case
   * produces identical output, so the filter could be deleted and the suite
   * would stay green while students were told their live classes had been
   * withdrawn.
   *
   * The archive transaction locks the TEMPLATE row, not these classes, so the
   * registration below commits from outside it. Under READ COMMITTED the
   * `deleteMany` re-evaluates its predicate when it runs, sees a charged
   * registration, and spares the class — #86's whole reason for keeping that
   * delete a single statement.
   */
  it('does not notify a waiter whose class was booked after the candidate read', async () => {
    const t = await makeTemplate('Race Spare');
    const c = await makeClass(t.id, { date: future() });
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    let raced = false;
    const interposing = prisma.$extends({
      query: {
        waitlistEntry: {
          async findMany({ args, query }) {
            const rows = await query(args);
            // Once, and only after the candidate read has returned: commit a
            // charged registration from outside the archive transaction.
            if (!raced) {
              raced = true;
              await prisma.registration.create({
                data: { classId: c.id, studentId, tierAtBooking: 3, status: 'registered' },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as typeof prisma;

    const result = expectArchived(
      await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived'),
    );

    // The interposition fired, or this test proves nothing.
    expect(raced).toBe(true);
    // The delete re-evaluated and spared the class.
    expect(result.deleted).toBe(0);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    // So the waiter must NOT have been told it was withdrawn.
    expect(
      await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
    ).toBe(0);
  });
```

- [ ] **Step 2: Run it and confirm it passes**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t 'booked after the candidate read'
```

Expected: PASS. Like the cascade pin, this asserts correct behaviour of code that already works — so Step 3 is what gives it value.

If `expect(raced).toBe(true)` fails, the interposition never fired: check that the candidate read is a `waitlistEntry.findMany` and not some other model, and that it runs inside the transaction the extended client drives.

- [ ] **Step 3: Prove it bites — mutate the survivor filter**

In `class-template-lifecycle.ts`, replace `const withdrawn = candidates.filter((c) => !survived.has(c.classId));` with:

```ts
        const withdrawn = candidates; // MUTATION: notify every candidate
```

Re-run → this test must FAIL at the notification count with `expected 1 to be 0`. Re-run Task 4's two tests as well: both still pass under this mutation, which is the demonstration that they could not have caught it.

Restore the filter and re-run the file clean.

- [ ] **Step 4: Commit**

```bash
git add src/services/class-template-lifecycle.test.ts
git commit -m "test: a filter nobody could have watched fail"
```

---

### Task 6: Whole-branch verification and the mutation ledger

**Files:**
- Create: `docs/superpowers/plans/2026-08-11-waitlist-withdrawal-notice-mutations.md`

**Interfaces:**
- Consumes: the recorded error text from Tasks 1–5.
- Produces: the evidence the PR body cites.

- [ ] **Step 1: Confirm the FK constraint was restored**

```bash
docker exec fairyoga-db-1 psql -U postgres -d fairyoga_test -c '\d "WaitlistEntry"' | grep -i "foreign key"
```

Expected: `ON DELETE CASCADE`. A test database left on `RESTRICT` by Task 1 poisons every later run, and the failure would surface somewhere unrelated.

- [ ] **Step 2: Confirm the delete statement was never touched**

```bash
git diff main -- src/services/class-template-lifecycle.ts | grep -n "deleteMany" -A6 -B6
```

Expected: the `deleteMany` and its comment block appear only as context, never as `+`/`-` lines. If they moved, that is a plan violation, not a formatting detail.

- [ ] **Step 3: Write the mutation ledger**

One row per guard, with the error text actually observed — not a paraphrase:

```markdown
# #112 mutation ledger

Every guard this branch adds, broken and observed to fail. Per §3 of the
solve-issue skill: a pin that compiles but cannot fail certifies nothing.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | `WaitlistEntry.class` cascade | FK → `ON DELETE RESTRICT` on the test DB | cascade pin | <exact text> |
| 2 | Auto-cancel waitlist read | delete the `findMany`, drop the spread | auto-cancel notice | <exact text> |
| 3 | Auto-cancel `removed` update | delete the `updateMany` | auto-cancel entry status | <exact text> |
| 4 | Erasure concatenation | `recipients` → `registrations` | queue-only erasure | <exact text> |
| 5 | Erasure empty-list guard | back to `registrations.length > 0` | queue-only erasure | <exact text> |
| 6 | Erasure `removed` update (pre-existing) | delete the `updateMany` | erasure entry status | <exact text> |
| 7 | Archive candidate read | delete the read + notify block | archive notice | <exact text> |
| 8 | Archive **survivor filter** | `withdrawn = candidates` | concurrency test | <exact text> |

**Guard 8 is the one that matters.** Guards 2, 4 and 7 are all provable by a
single non-concurrent test. Guard 8 is invisible to every such test — mutation
8 was run against the two ordinary archive tests as well, and both stayed
green. Record that here, because it is the argument for why the concurrency
test earns its complexity.
```

- [ ] **Step 4: Run the full verification gate**

```bash
npm run verify
```

Needs the app running on :3000 (the user runs it) — without it the integration project returns a wall of `ECONNREFUSED`. Expected: typecheck clean, lint clean, whole vitest suite green.

Green `verify` is a strong signal, not a substitute for CI: CI additionally runs `prisma validate`, a migration-drift check, `npm run build` and Playwright. Nothing here touches the schema, so drift should be nil — confirm rather than assume.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-waitlist-withdrawal-notice-mutations.md
git commit -m "docs: eight guards, each one watched to fail"
```

---

## What this plan does not do

Stated so a reviewer does not read absence as oversight:

- **It does not change what gets deleted.** A waiting entry still does not spare a class from archiving. Reopening that reopens #86's booked/unbooked line.
- **It does not touch the archive confirmation copy.** It stays *"3 classes withdrawn"*. A second persisted count means a migration and a number that can drift from what the transaction did — the exact failure #97 and #111 existed to remove.
- **It does not touch `template-sync.ts`** (path 5), unreachable with a queue: `addToWaitlist` requires `activeCount >= maxStudents`, `maxStudents >= 1`, therefore the class carried a registration, therefore `settingsLocked` is `true` — and `template-sync.ts:58` deletes only unlocked rows. `settingsLocked` is a one-way latch, so this is not a race.
- **It does not touch studio classes**, which have no waitlist and no registrations.
- **It does not widen which registration statuses an erasure emails.** `gdpr.ts:753-756` defers that (`registered` only, versus the sibling site's three); it stays deferred.
- **It adds no notification count to `ArchiveTemplateResult`.** The teacher's durable record is about their schedule; the students now hear directly, which was the gap.
