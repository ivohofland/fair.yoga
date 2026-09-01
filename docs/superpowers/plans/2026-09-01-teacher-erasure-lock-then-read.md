# `deleteTeacherAccount` lock-then-read fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the race in `deleteTeacherAccount` (`src/services/gdpr.ts`) where a
class becoming cancellable between its unlocked `upcoming` read and its later
`lockClassRowsOrdered` pre-lock ends up locked for the rest of the transaction
but never cancelled — orphaned under an erased teacher.

**Architecture:** Move the existing `lockClassRowsOrdered` call to run
immediately after the two template locks, before any class-level read.
Replace the unlocked `upcoming` read with a plain Prisma read scoped to
`id: { in: lockedIds } }` — the ids the lock statement itself returned — so
lock set and read set are identical by construction. This mirrors
`deleteStudentAccount`'s already-shipped lock-then-read shape a few functions
above in the same file. No changes to `src/lib/db-locks.ts`, its other three
callers, or the FOR-UPDATE census in that file and `docs/lock-order.md`.

**Tech Stack:** TypeScript, Prisma (raw `$queryRaw` for locking, ordinary
queries for everything else), Vitest (`vi.spyOn` for deterministic
in-process fault injection — no wall-clock timing races for the new tests).

**Spec:** `docs/superpowers/specs/2026-09-01-teacher-erasure-lock-then-read-design.md`

## Global Constraints

- No new raw SQL statement anywhere. The only raw `FOR UPDATE` statements
  touched by this branch are the existing ones in `db-locks.ts` and the two
  template locks in `gdpr.ts` — none of their SQL text changes, only where
  `lockClassRowsOrdered` is *called* from within `deleteTeacherAccount`.
- `lockClassRowsOrdered`'s exported signature (`db-locks.ts`) does not change.
  Its other three callers (`deleteStudentAccount`, `withdrawWaitingEntriesForTeacher`,
  `archiveOrUnarchiveTemplate`) are not touched.
- Comments state what is true now, not what used to be true — replace stale
  prose, don't annotate it with its own history (CLAUDE.md, *Comment
  Discipline*).
- Every claim this branch corrects gets corrected everywhere it appears —
  `gdpr.ts`'s own comments and `docs/lock-order.md`'s "Known conformance"
  bullet both describe the structure this branch changes.
- `npm run verify` must be green before any task is considered done. This
  branch touches `src/services/gdpr.test.ts`, which `vitest.config.ts` runs
  under the **`unit`** project (`include: ['src/**/*.test.ts']`, and it is
  not in that file's `SERIAL_TESTS` list), and `src/services/gdpr-lock-order.test.ts`,
  which is explicitly listed there and runs under **`unit-sweeps`**. Neither
  is `integration` (that project's `include` is `tests/integration/**/*.test.ts`
  only, and needs the dev server live on `:3000`; `unit`/`unit-sweeps` run
  against `DATABASE_URL_TEST` and need no server). Every `npx vitest run`
  command in this plan targets one of those two projects — get this wrong
  and the command reports "No test files found" rather than running
  anything.

---

### Task 1: Reorder the lock and the read, proven by a new regression test

**Files:**
- Modify: `src/services/gdpr.ts` (the `deleteTeacherAccount` transaction body)
- Modify: `src/services/gdpr.test.ts` (new test)

**Interfaces:**
- Consumes: `lockClassRowsOrdered` (`src/lib/db-locks.ts`) — unchanged
  signature, `(tx: TransactionClientOnly, source: { join?: Prisma.Sql; where:
  Prisma.Sql; entries?: boolean }) => Promise<string[]>`.
- Produces: nothing new consumed by later tasks — Task 2's tests import the
  same `dbLocks` namespace and mock the same function, independently.

- [ ] **Step 1: Write the failing regression test**

In `src/services/gdpr.test.ts`, add `import * as dbLocks from '@/lib/db-locks';`
alongside the existing `import { lockClassRow } from '@/lib/db-locks';` on
line 11 (both a named and a namespace import from the same module are valid
TypeScript; `dbLocks` does not collide with any existing identifier in this
file).

Add a new `describe` block. Place it after the `'deleteTeacherAccount cancels
by compare-and-swap (#174)'` block (it currently ends around line 1547, just
before the `'deleteTeacherAccount notifies whoever is registered when it
cancels (#174)'` block's docblock) — anchor on those two describe titles
rather than the line numbers, which will have shifted:

```ts
describe('deleteTeacherAccount locks and reads the same snapshot (#367)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-lockread-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'LockRead',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Lock-then-read fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'LockRead Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234LR',
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
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('cancels a class that becomes cancellable immediately before the class lock runs', async () => {
    // Fires exactly once, at the moment deleteTeacherAccount's Class+
    // CalendarEntry pre-lock is about to run (source.entries === true is
    // unique to that call — the two template locks above it in gdpr.ts are
    // separate inline $queryRaw statements, not calls to this function).
    // Creating the class HERE, immediately before letting the real lock
    // statement run, puts it in the exact position #367 describes: it did
    // not exist when today's unlocked `upcoming` read ran (that read has
    // already happened by the time this call fires), but it exists before
    // the lock statement's own predicate evaluates.
    const original = dbLocks.lockClassRowsOrdered;
    let injectedClassId: string | undefined;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        if (source.entries === true) {
          const created = await createClassFixture(prisma, {
            teacherId,
            teacherRoomId,
            classType: 'Injected class',
            date: new Date('2099-01-01'),
            startTime: hhmmToTime('09:00'),
            durationMinutes: 60,
            roomCost: 20,
            minRate: 15,
            targetRate: 25,
            minStudents: 1,
            maxStudents: 10,
            status: 'open',
          });
          injectedClassId = created.id;
        }
        return original(tx, source);
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    expect(injectedClassId).toBeDefined();
    const after = await prisma.class.findUniqueOrThrow({
      where: { id: injectedClassId! },
      include: { calendarEntry: true },
    });
    // The defect: today this class is locked (by the fresh predicate
    // lockClassRowsOrdered evaluates) but never visited by the cancel loop
    // (which walks the earlier, now-stale `upcoming` read) — so it survives
    // uncancelled under a teacher whose account no longer exists. Fixed
    // behaviour: lock set and read set are the same set, so this class is
    // cancelled like any other.
    expect(after.calendarEntry.cancelledAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails for the expected reason**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t "cancels a class that becomes cancellable immediately before the class lock runs"`

Expected: FAIL. `after.calendarEntry.cancelledAt` is `null` — the injected
class was locked but never cancelled. If it fails for a different reason
(e.g. a type error, a thrown exception), stop and diagnose before proceeding
— this step exists to confirm the test reproduces the *named* defect, not
merely that it fails.

- [ ] **Step 3: Reorder the statements in `deleteTeacherAccount`**

In `src/services/gdpr.ts`, inside `deleteTeacherAccount`'s `db.$transaction(async (tx) => { ... })` callback:

Delete the current first statement — the block starting at `const upcoming = await tx.class.findMany({` and its preceding comment (currently opens with `// Cancel every upcoming class and tell the people in them.`), ending at the closing `});` of that `findMany` call.

Keep the template-lock block that currently follows it completely
unchanged — `await setLockTimeout(tx);` through both `FOR UPDATE OF ct` /
`FOR UPDATE OF sct` raw statements and all of their existing comments. This
becomes the transaction's first code.

Immediately after the template locks, delete everything from the large
comment block that currently precedes the `lockClassRowsOrdered` call
(opens with `// Every class this erasure may cancel, locked ascending in
ONE statement`) through the **existing call itself** — that is, delete that
comment block, the `// VERDICT (#327): ...it never reads or writes an entry
column.` paragraph immediately above the call, AND the existing
`await lockClassRowsOrdered(tx, { ... });` statement, as one contiguous
region. Do not leave any part of that region in place and separately keep
the VERDICT paragraph "unchanged" — the replacement block below already
contains an accurate copy of it, verbatim; leaving the original in place
too would duplicate both the VERDICT comment and the `lockClassRowsOrdered`
call (the second an especially easy mistake to miss, since a duplicate call
still compiles and still passes — it just re-locks rows this transaction
already holds, a silent no-op).

Insert the block below in that region's place, **immediately after the
template locks** (i.e. right after the closing `` `FOR UPDATE OF sct``; ``
of the second template-lock statement) — not at the position of the
deleted `upcoming` read, which sat *before* the template locks and is a
different location:

```ts
      // Class + its CalendarEntry, locked ascending, in ONE statement,
      // BEFORE any read of this teacher's classes — this is what closes
      // the gap #367 found. Before this fix, an unlocked read ran first
      // and this same statement ran later, against a fresh predicate: a
      // class becoming cancellable in the gap between them was included in
      // this statement's lock set but absent from the earlier read, so the
      // loop below — which walked that read — never visited it. Locked for
      // the rest of the transaction, never cancelled.
      //
      // Lock set and read set are identical by construction now: the read
      // below asks for exactly `lockedIds`, not a separately re-evaluated
      // predicate. What still escapes: a class created or rescheduled into
      // a cancellable status AFTER this statement runs — inherent to any
      // read-then-transact system, not a gap this design leaves open by
      // choice.
      //
      // This is the transaction's SECOND lock acquisition overall (the
      // template locks above are first, #229) and its first read of any
      // `Class` data at all.
      //
      // VERDICT (#327): this transaction WRITES entry-level state — the
      // cancel below is `CalendarEntry.cancelledAt`, and its CAS
      // re-evaluates that column — so the entry rows are locked here too,
      // keeping the lock set a superset of the write set. The sibling
      // pre-lock in `deleteStudentAccount` above does NOT take
      // them: it never reads or writes an entry column.
      const lockedIds = await lockClassRowsOrdered(tx, {
        join: Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`,
        where: Prisma.sql`e."teacherId" = ${teacherId}
          AND e."cancelledAt" IS NULL
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})`,
        entries: true,
      });

      // Read AFTER the lock, scoped to exactly the ids it holds — under the
      // rows this transaction now holds, mirroring `deleteStudentAccount`'s
      // own lock-then-read shape above in this file. `orderBy` is kept for
      // the notification loop's determinism only; `lockedIds` is already
      // ascending (`lockClassRowsOrdered`'s own contract), so this read is
      // not what orders the locks.
      const upcoming = await tx.class.findMany({
        where: { id: { in: lockedIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          calendarEntry: {
            select: { id: true, classType: true, date: true, startTime: true },
          },
        },
      });
```

The `for (const cls of upcoming) { ... }` loop's *code* that follows is
unchanged — do not touch it. Three of its comments describe the old
structure, though, and go false under the new one; Step 4 below fixes them.

- [ ] **Step 4: Fix three now-stale comments inside the unchanged loop**

None of these change behavior — comment-only — but each states something
that becomes false once Step 3 lands, and this project's comment discipline
(CLAUDE.md, *Comment Discipline*) treats a false comment as a defect, not a
cosmetic gap.

**`gdpr.ts`, the comment opening the loop body** (currently reads
`// Compare-and-swap against the same statuses the read above filtered / //
on. A class can still reach \`completed\` between the read and the / //
pre-lock above — a sweep's \`completeClass\` doing exactly that is the / //
window \`email-fallback.ts\` describes, and the pre-lock's lock set is / //
a fresh status snapshot taken after the read, so such a class is not / //
held here. Cancelling it anyway would strip a class that already has / //
Payment rows and students who have been asked to pay. (Between the / //
pre-lock and here nothing can reach it: this loop's rows are all / //
held.)`, immediately followed by `// Skipping the CANCEL is the right
handling: ...`, unchanged) — replace only the first block (through `held.)`)
with:

```ts
        // Compare-and-swap, defensive rather than load-bearing now:
        // `upcoming` is read scoped to `lockedIds`, so every row reaching
        // this loop was already held by the pre-lock above before this
        // transaction's own read ran — nothing else can complete or cancel
        // it in between (#367). A concurrent completer (`completeClass`,
        // `class-lifecycle.ts`) takes `lockClassRow` itself, so it queues
        // behind this hold rather than racing it. Kept anyway: the CAS's
        // WHERE is what actually enforces "still cancellable", and a
        // future change landing between the lock and here should fail
        // loud — a warn and a skip — rather than silently cancel a class
        // it should not have. Cancelling a completed class anyway would
        // strip one that already has Payment rows and students who have
        // been asked to pay.
```

**`gdpr.ts`, inside the `cancelled.count === 0` branch** — the sentence
`"does not touch the waitlist" is exactly what the test "leaves a class
that completed after the erasure read alone, and still erases" pins` names
a test Task 2 Step 1 renames. Replace just that quoted test name with the
new one: `"does not touch the waitlist" is exactly what the test "warns and
skips when a locked id turns out not to be cancellable" pins`. Nothing else
in that paragraph changes.

**`gdpr.ts`, above the per-row registration/waitlist re-read** (currently
`// Read HERE, under the row lock the CAS above just took — not from / //
the \`findMany\` at the top of this transaction, which took no lock / //
and whose snapshot is already stale by the time the CAS lands. A / //
student who registered in that gap had their class cancelled by the / //
statement above and, from the old eager-loaded list, was never told. / //
The same defect and the same fix as \`autoCancelClasses\` / //
(\`class-transitions.ts\`), for the same reason its comment gives: a / //
cancelled class nobody was told about is worse than one that stays / //
open one more sweep. Under the lock, a registration writer either / //
committed before the CAS — and is in this read — or is blocked / //
behind it until this transaction ends.`) — the claim that the top-level
`findMany` "took no lock" is false after Step 3 (`upcoming` is now read
under the pre-lock). Replace with:

```ts
        // Read HERE, under the row lock the pre-lock above already took —
        // `upcoming` never selected this data to begin with, so this is
        // the only place it is fetched, not a second read replacing a
        // stale eager-load. The same defect and the same fix as
        // `autoCancelClasses` (`class-transitions.ts`), for the same
        // reason its comment gives: a cancelled class nobody was told
        // about is worse than one that stays open one more sweep. Under
        // the lock, a registration writer either committed before this
        // transaction's own class-level read — and is in this read — or
        // is blocked behind the held row until this transaction ends
        // (#367).
```

These are comment-only edits — Step 5 below re-runs the test and confirms
nothing in the surrounding code was accidentally touched while editing
comments in place.

- [ ] **Step 5: Run the new test and confirm it passes**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t "cancels a class that becomes cancellable immediately before the class lock runs"`

Expected: PASS.

- [ ] **Step 6: Run the whole file and record which tests now fail**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: most tests pass. Two are **expected to fail** at this point —
`'leaves a class that completed after the erasure read alone, and still
erases'` and `'tells a student who registered after the class read but
before the cancel'`. This is diagnostic, not a regression: both inject a
concurrent write into a window (between the old unlocked read and the old
lock) that this reorder removes. Both discriminate "the transaction's read"
by `where.status` being an `{ in: [...] } }` object; after this reorder that
read carries `where: { id: { in: lockedIds } }` instead, with no `status`
key at all, so each hook's `isTransactionRead` check is now `false` on
every call. Expected failure is a **plain assertion failure, not a hang or
a deadlock timeout**: the first test should fail at its `expect(after.status).toBe('completed')`
assertion (receiving `'in_progress'` — the injected concurrent completion
never fires, because the hook no longer recognizes the transaction's read);
the second should fail at `expect(hookCalls).toBe(1)` (receiving `0` — the
injected registration never runs). Confirm the actual output matches this
before continuing — if either fails a different way, that's new information
Task 2 needs, not something to paper over.

**Do not modify either failing test in this task.** That is Task 2, and it
depends on this step's recorded output.

If any *other* test in the file fails, stop — that is a real regression
from Step 3's reorder, not one of the two anticipated cases, and needs
fixing before continuing.

- [ ] **Step 7: Run the deadlock reproduction test**

Run: `npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts`

Expected: PASS, unmodified. This test races the two `lockClassRowsOrdered`
pre-lock statements directly via a forced-plan hook on `setLockTimeout`'s
`$executeRawUnsafe` call — `setLockTimeout` is still the first raw statement
`deleteTeacherAccount`'s transaction issues (the deleted `upcoming` read was
never a raw statement, so it was never what the hook "rode"), so this
mechanism is unaffected by the reorder. If this fails, stop and diagnose
before continuing — this is the one test in the suite whose entire purpose
is catching exactly the kind of statement-order change this task makes.

- [ ] **Step 8: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "$(cat <<'EOF'
fix: lock deleteTeacherAccount's classes before reading them (#367)

Closes the race where a class becoming cancellable between the unlocked
upcoming read and the later lockClassRowsOrdered pre-lock was locked by
the pre-lock's fresh snapshot but never visited by the cancel loop,
which walked the earlier, now-stale read -- orphaned uncancelled under
an erased teacher. lockClassRowsOrdered now runs immediately after the
template locks, before any class-level read; the read is scoped to
lockClassRowsOrdered's own returned ids, so lock set and read set are
identical by construction, mirroring deleteStudentAccount's existing
lock-then-read shape a few functions above in the same file.

Spec: docs/superpowers/specs/2026-09-01-teacher-erasure-lock-then-read-design.md
EOF
)"
```

---

### Task 2: Rebuild the two tests whose race window this closes

**Files:**
- Modify: `src/services/gdpr.test.ts`

**Interfaces:**
- Consumes: `dbLocks.lockClassRowsOrdered` (mocked the same way as Task 1's
  test — `vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(...)`,
  discriminated on `source.entries === true`).
- Produces: nothing consumed by Task 3.

This task depends on Task 1's Step 6 output — the exact failure mode of both
tests against the reordered code. Read that recorded output before writing
either replacement below; if it contradicts the reasoning here (e.g. a test
fails with a different error than expected), treat the recorded output as
authoritative and adjust the replacement, not the other way around.

- [ ] **Step 1: Replace `'leaves a class that completed after the erasure read alone, and still erases'`**

In the `'deleteTeacherAccount cancels by compare-and-swap (#174)'` describe
block, replace the entire body of this `it`. The old body races a concurrent
completion into the transaction's `class.findMany` call via an `$extends`
hook keyed on `status` being an `{ in: [...] } }` object — that call, and
the window it depends on, no longer exist after Task 1. The property worth
keeping — the CAS's `count === 0` branch still warns and skips correctly
when the row it expected to cancel turns out not to be cancellable — is
now constructed directly instead of via a race:

```ts
  it('warns and skips when a locked id turns out not to be cancellable', async () => {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'CAS class',
      date: new Date('2026-06-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
    });
    const classId = cls.id;

    await prisma.registration.create({
      data: { classId, studentId: registeredStudentId, status: 'registered', tierAtBooking: 2 },
    });
    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // lockClassRowsOrdered's real predicate never returns a completed
    // class's id -- this simulates a lock/CAS disagreement directly.
    // After #367 that disagreement can no longer arise from a genuine
    // timing race (once a row is locked, nothing else can complete or
    // cancel it before the CAS reaches it), so this proves the defensive
    // branch still fires correctly without depending on a race that no
    // longer exists.
    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    const after = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: { calendarEntry: true },
    });
    expect(after.status).toBe('completed');
    expect(after.calendarEntry.cancelledAt).toBeNull();

    const waitlistEntry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: waitingStudentId } },
    });
    expect(waitlistEntry.status).toBe('waiting');
    const cancelledNotice = await prisma.notification.findFirst({
      where: {
        recipientType: 'student',
        recipientId: registeredStudentId,
        type: 'class_cancelled',
        relatedClassId: classId,
      },
    });
    expect(cancelledNotice).toBeNull();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ classId, observedStatus: 'completed' }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ waitingEntriesLeft: 1 }),
      expect.anything(),
    );
  });
```

Add `import * as dbLocks from '@/lib/db-locks';` if Task 1 hasn't already
added it (it has, in Step 1 — this test reuses the same import, don't add
it twice).

The describe block's `beforeAll`/`afterAll` and its `registeredStudentId`/
`waitingStudentId` fixtures are unchanged — this replacement uses them
as-is.

- [ ] **Step 2: Run it in isolation**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t "warns and skips when a locked id turns out not to be cancellable"`

Expected: PASS.

- [ ] **Step 3: Replace `'tells a student who registered after the class read but before the cancel'`, its describe title, and its docblock**

In the `'deleteTeacherAccount notifies whoever is registered when it cancels
(#174)'` describe block, replace the entire body of this `it` — the sole
test in that block. The old body races a `Registration` create into the
transaction's `class.findMany` call, asserting it "cannot block here" — a
premise this reorder makes false: by the time that read runs,
`lockClassRowsOrdered` already holds the row, and Postgres takes an
automatic `FOR KEY SHARE` lock on it for any `INSERT` referencing it (the
mechanism `docs/lock-order.md`'s advisory-lock section calls "the fourth
path"), which conflicts with `FOR UPDATE`. Replace it with a direct proof
of that new guarantee, in the same causal-ordering style as
`deleteStudentAccount`'s existing `'waits for a class row another
transaction holds before renumbering other students'` test earlier in this
file. Synchronize on a signal resolved *inside* the mock, not a fixed
`setTimeout`, so the test cannot start the registration before the erasure
has actually reached the lock — and wrap the mid-race assertion in
`try`/`finally` so a failure there still releases the held transaction
instead of leaving it open until the 15s test timeout:

```ts
  it('blocks a concurrent registration on a class it is about to cancel, until it commits', async () => {
    let reachedLock!: () => void;
    const atLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    let releaseLock!: () => void;
    const heldOpen = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        if (source.entries === true) {
          reachedLock();
          await heldOpen;
        }
        return ids;
      });
    onTestFinished(() => spy.mockRestore());

    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => 'erased' as const);
    await atLock;

    let registrationLanded = false;
    const registering = prisma.registration
      .create({ data: { classId, studentId: lateStudentId, status: 'registered', tierAtBooking: 3 } })
      .then(() => {
        registrationLanded = true;
      });

    try {
      await new Promise((r) => setTimeout(r, 400));
      // Still blocked: the erasure holds the Class row's FOR UPDATE lock,
      // and the registration INSERT's automatic FOR KEY SHARE lock on that
      // same row conflicts with it. This is what makes the old #174 race --
      // registering in the gap between an unlocked read and the class lock
      // -- structurally impossible now, not merely unlikely.
      expect(registrationLanded).toBe(false);
    } finally {
      releaseLock();
    }

    await Promise.all([erasing, registering]);
    expect(registrationLanded).toBe(true);

    // The registration that finally landed, after the class was already
    // cancelled, is still there -- this design does not lose it, it just
    // cannot land DURING the erasure any more.
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: lateStudentId } },
    });
    expect(reg.status).toBe('registered');
  }, 15_000);
```

The describe block's `beforeAll`/`afterAll` and its `classId`/
`earlyStudentId`/`lateStudentId` fixtures are unchanged.

**Rename the describe block and rewrite its docblock.** The old title and
docblock are both specifically about notification — accurate for the old
test, but this block now holds a test about a locking guarantee instead.
Leaving them as-is would describe a property this file no longer pins here
(the notification property itself is still pinned elsewhere — e.g.
`gdpr.test.ts`'s `'tells a queued student when the teacher erases their
account, with nobody registered'` test — so nothing goes uncovered, but
this block's own label would be actively misleading). Replace the docblock
immediately above `describe('deleteTeacherAccount notifies whoever is
registered when it cancels (#174)', () => {` (the one opening `/**
* Whole-branch review of #174, Important. ...`) and the describe title
itself with:

```ts
/**
 * Whole-branch review of #174, Important, closed further by #367.
 * Originally: `deleteTeacherAccount` read its classes — and, eager-loaded
 * alongside them, the registrations it would notify — before taking any
 * lock, then cancelled under the CAS's lock and built the notifications
 * from that pre-lock snapshot. A student who registered in between had
 * their class cancelled and was never told. #174's whole-branch review
 * fixed the notification half by re-reading recipients under the lock
 * (`class-lifecycle.ts`'s `autoCancelClasses` got the identical fix at the
 * same time, for the same reason its own comment states — "a cancelled
 * class nobody was told about is worse than one that stays open one more
 * sweep").
 *
 * #367 closes the registration half of the same gap structurally: the
 * class lock now runs before any read, so a registration can no longer
 * land between an unlocked read and the lock at all — it blocks behind the
 * held row (Postgres's automatic `FOR KEY SHARE` on the referencing
 * `INSERT`) until the erasure transaction ends. The test below proves that
 * directly.
 */
describe('deleteTeacherAccount blocks concurrent registrations on classes it locks (#367)', () => {
```

**Remove the now-unused `lockClassRow` import.** `lockClassRow` (imported on
line 11: `import { lockClassRow } from '@/lib/db-locks';`) is used nowhere
else in this file — confirmed by `grep -n 'lockClassRow(' src/services/gdpr.test.ts`,
which after this step's replacement returns no hits. Delete that import
line; it would otherwise fail `no-unused-vars` under this project's strict
lint config. Leave the `import * as dbLocks from '@/lib/db-locks';` Task 1
added on the same area — it's used by all three new/rebuilt tests.

- [ ] **Step 4: Run it in isolation**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t "blocks a concurrent registration on a class it is about to cancel, until it commits"`

Expected: PASS.

- [ ] **Step 5: Run the whole file**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: every test passes, including Task 1's new test and both
replacements from this task.

- [ ] **Step 6: Commit**

```bash
git add src/services/gdpr.test.ts
git commit -m "$(cat <<'EOF'
fix(test): rebuild two deleteTeacherAccount races #367 makes impossible

Both tests injected a concurrent write into the window between the
unlocked upcoming read and the later class-row lock -- exactly the
window the prior commit closes. The CAS-mismatch coverage is now
constructed directly (a lockClassRowsOrdered mock hands back an id that
is not actually cancellable) instead of racing a status change into a
read that no longer exists. The late-registration coverage now proves
the new invariant directly: a concurrent registration blocks behind the
erasure's held Class lock (Postgres's automatic FOR KEY SHARE on the
FK insert) until the erasure transaction commits, rather than proving
a late registration still gets notified -- it can no longer land during
the erasure at all.

Spec: docs/superpowers/specs/2026-09-01-teacher-erasure-lock-then-read-design.md
EOF
)"
```

---

### Task 3: Correct `docs/lock-order.md`'s stale `deleteTeacherAccount` description

**Files:**
- Modify: `docs/lock-order.md`

**Interfaces:** None — documentation only, no code dependency on or from
other tasks.

- [ ] **Step 1: Locate and replace the stale bullet**

Find the `deleteTeacherAccount` bullet in the "Known conformance" section
(search for `**\`deleteTeacherAccount\`** (\`src/services/gdpr.ts\`) —
\`Class\`, via an ordered`). It currently reads:

> **`deleteTeacherAccount`** (`src/services/gdpr.ts`) — `Class`, via an ordered
> `lockClassRowsOrdered` pre-lock over every class in `CANCELLABLE_STATUSES`,
> taken before the cancel loop and first in the transaction (#237). The loop's
> per-class compare-and-swap `class.updateMany` re-takes rows that pre-lock
> already holds, so the read's `orderBy: { id: 'asc' }` is presentation only
> now (notification order) — see "Ordering WITHIN `Class`" for what it used to
> be and why it stopped. Then, per class, `WaitlistEntry` and the `Registration` read that
> chooses who gets the cancellation notice — that read moved inside the lock
> in the whole-branch review of #174, having been an eager-load on the
> pre-lock `findMany` until then, which meant a student registering in the gap
> had their class cancelled and was never told. After the loop:
> `StudentPrivacy`, `TeacherStudent`, `Invitation` (deleted, not anonymized —
> the teacher is soft-deleted, not scrubbed like a student's identity is).

Two things are wrong with this passage, one pre-existing and one this
branch introduces if left uncorrected:

1. **"first in the transaction" was already false before this branch.** The
   two template locks (#229, `ClassTemplate`/`StudioClassTemplate`,
   `gdpr.ts`) run before the class pre-lock and landed after this passage
   was written — found while researching #367, unrelated to it, but in the
   same passage this branch's own reorder touches.
2. **The read this passage describes no longer exists in the form
   described.** There is no more separate, earlier `upcoming` read whose
   `orderBy` is "presentation only" relative to an already-independently-
   locked set — the read is now scoped to the lock's own returned ids.

Replace the bullet with:

```markdown
- **`deleteTeacherAccount`** (`src/services/gdpr.ts`) — `Class`, via an
  ordered `lockClassRowsOrdered` pre-lock over every class in
  `CANCELLABLE_STATUSES`. Not first in the transaction — the two template
  locks (#229, `ClassTemplate`/`StudioClassTemplate`) run before it — but
  first among `Class`/`CalendarEntry` locks, and first read of any `Class`
  data at all (#367): the read that feeds the cancel loop is scoped to
  `id: { in: lockedIds } }`, the ids this same pre-lock statement returned,
  not an independently-timed read. `orderBy: { id: 'asc' }` on that read is
  presentation only (notification order) — `lockedIds` is already ascending,
  so nothing about lock ORDER depends on it; see "Ordering WITHIN `Class`"
  for what it used to order and why it stopped. Then, per class,
  `WaitlistEntry` and the `Registration` read that chooses who gets the
  cancellation notice — under the same lock, not a separate eager-load (#174
  whole-branch review: a student registering after an eager-loaded read had
  their class cancelled and was never told; #367 additionally closed the
  window such a registration could land in at all, via the automatic `FOR
  KEY SHARE` lock the "fourth path" above already documents for a different
  insert). After the loop: `StudentPrivacy`, `TeacherStudent`, `Invitation`
  (deleted, not anonymized — the teacher is soft-deleted, not scrubbed like
  a student's identity is). Was already `StudentPrivacy` before
  `TeacherStudent`; not the outlier.
```

**Do not lose that last sentence.** The current bullet ends `...not
scrubbed like a student's identity is). Was already \`StudentPrivacy\`
before \`TeacherStudent\`; not the outlier.` — that final sentence is this
entry's answer to an ordering question the neighbouring `unlinkTeacher`
entry raises, and it is easy to drop by accident since it reads like a
trailing fragment. Confirm the replacement above still has it before
moving on.

- [ ] **Step 2: Check for other passages this branch's reorder invalidates**

Run: `grep -n 'deleteTeacherAccount' docs/lock-order.md`

For each hit not already addressed by Step 1, read the surrounding
paragraph and verify it still describes the code accurately after Task 1's
reorder (most describe the template-lock ordering, the studio-family
comparison, or the `#229` history — orthogonal to this change and expected
to still be accurate; verify rather than assume). Fix any that have gone
stale, following the same "replace the claim, don't annotate its history"
rule as Step 1.

**One specific hit needs this now, not "verify rather than assume":** the
"Ordering WITHIN `Class`" section (currently around line 569) has a
paragraph reading:

> Since #237 an ordered `lockClassRowsOrdered` pre-lock runs ahead of that
> loop, so the rule no longer describes this site: the pre-lock is the
> transaction's first lock acquisition, and the read's `orderBy: { id: 'asc' }`
> is now presentation only (it fixes the notification order). The rule
> still applies to any future loop that CASes without pre-locking, which is
> why it is kept. Pinned by `gdpr.test.ts`, "does not deadlock when a
> teacher erasure and a student erasure overlap on two classes"; that test
> fails with `40P01` if the pre-lock is removed. The same fix closes the
> inherited disagreement with `withdrawWaitingEntriesForTeacher`, which has
> sorted since #166.

This has the same "first lock acquisition" staleness as the Known
Conformance bullet, plus its own pre-existing one, unrelated to #367 but
found while reading this passage: the pinning test it names,
`gdpr.test.ts`, moved to `gdpr-lock-order.test.ts` at some point before
this branch (confirm with `grep -n 'does not deadlock when a teacher
erasure and a student erasure overlap on two classes' src/services/*.test.ts`
— it should hit `gdpr-lock-order.test.ts` only). Replace the paragraph with:

```markdown
Since #237 an ordered `lockClassRowsOrdered` pre-lock runs ahead of that
loop, so the rule no longer describes this site: the pre-lock is first
among `Class`/`CalendarEntry` locks (not first in the transaction — #229's
`ClassTemplate`/`StudioClassTemplate` locks run before it), and since #367
it is also first among ANY read of this teacher's classes — the read the
loop walks is scoped to the pre-lock's own returned ids, not an
independently-timed `findMany`, so `orderBy: { id: 'asc' }` on that read is
presentation only (it fixes the notification order) for a stronger reason
than before: there is no longer a separate snapshot for it to agree or
disagree with. The rule still applies to any future loop that CASes
without pre-locking, which is why it is kept. Pinned by
`gdpr-lock-order.test.ts`, "does not deadlock when a teacher erasure and a
student erasure overlap on two classes"; that test fails with `40P01` if
the pre-lock is removed. The same fix closes the inherited disagreement
with `withdrawWaitingEntriesForTeacher`, which has sorted since #166.
```

- [ ] **Step 3: Commit**

```bash
git add docs/lock-order.md
git commit -m "$(cat <<'EOF'
docs: correct deleteTeacherAccount's lock-order description (#367)

The "Known conformance" bullet claimed the class pre-lock ran first in
the transaction, which #229's template locks already made false before
this branch, and described a read this branch's reorder replaces.
Corrected in place rather than annotated, per this repo's comment
discipline.

Spec: docs/superpowers/specs/2026-09-01-teacher-erasure-lock-then-read-design.md
EOF
)"
```

---

## Final verification (after all three tasks)

- [ ] Run `npm run verify` (typecheck, lint, unit, components, integration —
  needs the dev server live on `:3000`; do not start or restart it yourself,
  see the `verify` skill).
- [ ] Confirm `docs/lock-order.md`'s two FOR-UPDATE census greps still report
  exactly five lines each (unchanged by this branch, per the spec's §7 — this
  confirms it, doesn't just assert it):

```bash
grep -rn 'FOR UPDATE' --include='*.ts' src/ | grep -v '\.test\.ts:' \
  | grep -vE ':[0-9]+: *(\*|//)' \
  | grep -vE 'OF (ct|sct|tpl)`|"ClassTemplate"|"StudioClassTemplate"|family\.childTable'
```

- [ ] Push and open the PR. In the body: state the arithmetic behind a green
  `npm run verify` — `<total> = <unit> unit + <components> components +
  <unit-sweeps and other serial-tier totals> + <integration> integration` —
  re-derived from that run's own output at PR time, not copied from any
  prior PR or from this plan. This branch's own test changes live in the
  `unit` project (`src/services/gdpr.test.ts` — Task 1 adds one new test,
  Task 2 rebuilds two others without adding or removing one, so the `unit`
  count should read one higher than the branch's base commit) and the
  `unit-sweeps` project (`src/services/gdpr-lock-order.test.ts`, unmodified
  — its count should be unchanged). State that arithmetic, don't just
  assert it. Name `src/services/gdpr.ts` and `docs/lock-order.md` as
  touched non-test files, and `src/services/gdpr.test.ts` (`unit`) /
  `src/services/gdpr-lock-order.test.ts` (`unit-sweeps`) by their correct
  tiers — neither is `integration`. Because neither tier this branch
  touches needs the dev server or the shared dev DB (both run against
  `DATABASE_URL_TEST`), they can be run and verified locally even from a
  worktree; only cite a CI run in place of a local `verify` for the
  `integration`/`e2e` tiers `npm run verify` also covers, per this
  project's usual worktree rule.
