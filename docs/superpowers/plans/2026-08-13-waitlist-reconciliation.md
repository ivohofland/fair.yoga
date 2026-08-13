# Waitlist Reconciliation Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduler sweep that finds classes where a seat is free and students are still queued, and re-runs `handleSpotFreed` on them — so a notification dropped by a lock timeout or a transaction budget is repaired within a minute instead of lost forever.

**Architecture:** One new service, `src/services/waitlist-reconciliation.ts`, plus one new entry in the scheduler's job array. The sweep only **detects**; `handleSpotFreed` keeps **deciding** what to do. No window logic, capacity policy, or promote-vs-broadcast branch is reimplemented, which is why the sweep covers both failure modes without addressing either one specifically.

**Tech Stack:** TypeScript (`strict: true`), Prisma 7, PostgreSQL, Vitest (`unit` project, runs against `ethical_yoga_test`).

**Spec:** `docs/superpowers/specs/2026-08-13-waitlist-reconciliation-design.md` — read it before Task 1. Section references below (§4.2, §4.3, §4.5) point into it.

## Global Constraints

- TypeScript `strict: true`. No `any`, no implicit types, no non-null assertion added to silence a compiler error you have not understood.
- Test-first. Every step below is ordered write-test → see-it-fail → implement → see-it-pass. Do not reorder.
- Services are framework-agnostic: no HTTP concerns, no `next/*` imports in `src/services/`.
- **No migration and no schema change.** If you believe you need one, stop and report — the design was chosen specifically to avoid one.
- **Do not modify `src/services/waitlist.ts`.** `handleSpotFreed` keeps its exact current signature and behaviour. If a task seems to require changing it, stop and report.
- **Never start or restart the dev server on :3000.** The user runs it.
- Stage exact paths. Never `git add -A` or `git add .`.
- Run `npx vitest run --project unit <path>` for the inner loop. `npm run verify` only at the end of Task 4.

---

## Derailers — read these before Task 1

Three things in this codebase will cost you an hour each if you meet them cold.

**1. Injected clocks and database clocks are different clocks.** Tests place a class in a chosen waitlist window by passing `opts.now` — a date in 2099. But `Notification.createdAt` is `@default(now())`, so a notification the test causes to be written gets a **2026** timestamp. The §4.3 gate compares `createdAt >= claimWindowStart`, and a 2026 timestamp is not inside a 2099 window. Any test that needs the gate to *see* a notification must set `createdAt` explicitly on create. This is not a bug in the gate — in production both clocks are the same clock.

**2. Never hard-code a window boundary.** Derive every test timestamp from `classStartInstant(...)`, as the fixtures below do. Hard-coding `2099-05-31T07:30:00Z` assumes the IANA database still projects European DST the same way in 2099. Deriving from `classStartInstant` is correct whatever it projects.

**3. A wall-clock assertion is not a proposition about locks.** `src/services/waitlist.test.ts:1622-1628` records a test that raced the hook against a 400 ms timer and passed 4 runs in 5 *with the lock deleted*, because a loaded machine made it look slow. Assert an outcome slowness cannot produce — a SQLSTATE, a row that exists or does not — never "it had not finished yet". Hold the row with a **separate `PrismaClient`** and assert the holder had not released before the call under test returned.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/waitlist-reconciliation.ts` (create) | Detect classes needing reconciliation; invoke `handleSpotFreed`; return a summary. Nothing else. |
| `src/services/waitlist-reconciliation.test.ts` (create) | All six tests. Own fixtures, own teacher/room, cleaned up in `afterAll`. |
| `src/lib/scheduler.ts` (modify) | One import, one entry in the `jobs` array. |
| `docs/lock-order.md` (modify) | Re-run its `lockClassRow(` caller grep and restate the count. |
| `docs/audits/2026-07-18-review-round-2.md` (modify) | Mark line 75's observation answered. |

A new file rather than an addition to `waitlist.ts`, which is already ~900 lines. This module observes the queue; its only mutation happens through `handleSpotFreed`.

---

## Task 1: Detection, and the auto-promote half

**Files:**
- Create: `src/services/waitlist-reconciliation.ts`
- Create: `src/services/waitlist-reconciliation.test.ts`

**Interfaces:**
- Consumes: `handleSpotFreed(db: PrismaClient, classId: string, now?: Date): Promise<SpotFreedResult>` and `getWaitlistWindow(classDate: Date, startTime: string, cancelDeadline: CancelDeadline, timeZone: string, now?: Date): WaitlistWindow`, both from `./waitlist`. `ACTIVE_REGISTRATION_STATUSES: readonly RegistrationStatus[]` from `@/lib/registration-status`.
- Produces: `reconcileWaitlists(db: PrismaClient, opts?: { now?: Date }): Promise<ReconcileSummary>` and `interface ReconcileSummary { candidates: number; reconciled: number; failed: number }`. Task 2 adds a gate inside this function; Task 3 adds error isolation to its loop; Task 4 registers it.

- [ ] **Step 1: Write the fixture and the first failing test**

Create `src/services/waitlist-reconciliation.test.ts`:

```ts
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';
import { addToWaitlist } from './waitlist';
import { reconcileWaitlists } from './waitlist-reconciliation';

const prisma = new PrismaClient();
const suffix = `recon-${Date.now()}`;

const CLASS_DATE = new Date('2099-06-01');
const TZ = 'Europe/Amsterdam';
const H = 60 * 60 * 1000;

/**
 * Every window boundary is DERIVED, never hard-coded — see derailer 2. With
 * `cancelDeadline: 'HOURS_24'` the deadline is `classStart - 24h` and the claim
 * window is `[classStart - 25h, classStart - 24h)`.
 */
function windowClocks(startTime: string) {
  const classStart = classStartInstant(CLASS_DATE, startTime, TZ);
  return {
    classStart,
    autoPromote: new Date(classStart.getTime() - 48 * H),
    inClaimWindow: new Date(classStart.getTime() - 24.5 * H),
    frozen: new Date(classStart.getTime() - 12 * H),
  };
}

describe('reconcileWaitlists (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  const classIds: string[] = [];
  const studentIds: string[] = [];
  let slotCounter = 0;

  /** Distinct `HH:MM` per class — `Class_teacher_slot_unique` is string equality. */
  function nextSlot(): string {
    slotCounter += 1;
    return `${String(10 + Math.floor(slotCounter / 60)).padStart(2, '0')}:${String(
      slotCounter % 60,
    ).padStart(2, '0')}`;
  }

  async function makeClass(maxStudents: number): Promise<{ id: string; startTime: string }> {
    const startTime = nextSlot();
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: CLASS_DATE,
        startTime,
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents,
        status: 'open',
        cancelDeadline: 'HOURS_24',
        settingsLocked: true,
      },
    });
    classIds.push(cls.id);
    return { id: cls.id, startTime };
  }

  async function makeStudent(label: string): Promise<string> {
    const student = await prisma.student.create({
      data: {
        firstName: label,
        lastName: 'Recon',
        email: `${suffix}-${label}-${studentIds.length}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    return student.id;
  }

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Recon',
        lastName: 'Teacher',
        email: `${suffix}-teacher@test.local`,
        account: { create: { email: `${suffix}-teacher@test.local` } },
        bio: 'reconciliation fixtures',
        pageSlug: suffix,
        defaultTimezone: TZ,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Recon Studio',
        address: `${suffix} Recon St`,
        city: 'Amsterdam',
        postcode: '1234RC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 35 },
    });
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  /**
   * The class this sweep exists for: a seat is free, someone is queued, and the
   * live hook never delivered. Task 1 proves the sweep repairs that state; the
   * end-to-end drop that CREATES the state is proved in Step 7.
   */
  it('promotes the queue head of a class with a free seat', async () => {
    const cls = await makeClass(1);
    const filler = await makeStudent('Filler');
    const waiter = await makeStudent('Waiter');

    await prisma.registration.create({
      data: { classId: cls.id, studentId: filler, status: 'registered', tierAtBooking: 3 },
    });
    // The class must be full for a join to be legal.
    await addToWaitlist(prisma, cls.id, waiter);
    // Now free the seat WITHOUT running the hook — this is the dropped state.
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
    });

    expect(summary.reconciled).toBe(1);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: FAIL — the module does not exist yet, so the import fails to resolve. Record the exact message.

- [ ] **Step 3: Write the implementation**

Create `src/services/waitlist-reconciliation.ts`:

```ts
/**
 * Reconciles waitlists whose spot-freed hook never delivered.
 *
 * `handleSpotFreed` can fail two different ways, and both end with a waiting
 * student silently not told and nothing retrying (#220):
 *
 *   - the broadcast branch aborts at `lockClassRow`'s 2s `SET LOCAL
 *     lock_timeout` with `55P03`, while the contending writer still holds the
 *     row;
 *   - the auto-promote branch blows Prisma's default 5s interactive-transaction
 *     budget with `P2028`, measured at 7014 ms against a 7 s hold — it waits out
 *     the whole hold and fails afterwards, because Prisma cannot cancel a
 *     statement already blocked inside Postgres (`gdpr.ts:602`).
 *
 * Both callers log and swallow, so this sweep is the only thing that makes
 * either loss recoverable. It also covers a student who was merely offline,
 * which is the never-filed observation at
 * `docs/audits/2026-07-18-review-round-2.md:75`.
 *
 * **This module detects; `handleSpotFreed` decides.** No window logic, capacity
 * policy or promote-vs-broadcast branch is reimplemented here. That is what
 * makes the auto-promote half covered without a line addressing it, and it is
 * why re-running the hook is the whole action.
 */
import type { PrismaClient } from '@prisma/client';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { getWaitlistWindow, handleSpotFreed } from './waitlist';

export interface ReconcileSummary {
  /** Classes holding at least one `waiting` entry that were examined. */
  candidates: number;
  /** Classes on which `handleSpotFreed` was invoked. */
  reconciled: number;
  /** Classes whose invocation threw. */
  failed: number;
}

export async function reconcileWaitlists(
  db: PrismaClient,
  opts: { now?: Date } = {},
): Promise<ReconcileSummary> {
  // Start from the waiting entries, not from the classes: most classes have no
  // queue, and this is the narrowest set that can possibly need reconciling.
  const queued = await db.waitlistEntry.findMany({
    where: { status: 'waiting' },
    select: { classId: true },
    distinct: ['classId'],
  });
  const candidateIds = queued.map((q) => q.classId);
  if (candidateIds.length === 0) return { candidates: 0, reconciled: 0, failed: 0 };

  const classes = await db.class.findMany({
    where: { id: { in: candidateIds }, status: 'open' },
    select: {
      id: true,
      date: true,
      startTime: true,
      cancelDeadline: true,
      maxStudents: true,
      teacher: { select: { defaultTimezone: true } },
    },
  });

  // One grouped count for the whole candidate set, not one count per class: this
  // runs every minute on a 2 GB VPS.
  const counts = await db.registration.groupBy({
    by: ['classId'],
    where: {
      classId: { in: candidateIds },
      status: { in: [...ACTIVE_REGISTRATION_STATUSES] },
    },
    _count: { _all: true },
  });
  const activeByClass = new Map(counts.map((c) => [c.classId, c._count._all]));

  let reconciled = 0;

  for (const cls of classes) {
    const window = getWaitlistWindow(
      cls.date,
      cls.startTime,
      cls.cancelDeadline,
      cls.teacher.defaultTimezone,
      opts.now,
    );
    if (window === 'frozen') continue;

    // A class ABSENT from the groupBy has zero active registrations, not zero
    // free seats. `?? 0` is what keeps the emptiest classes — the ones most
    // obviously in need of reconciling — inside the candidate set. Defaulting
    // the other way, or skipping the misses, inverts this filter exactly where
    // it matters most.
    const activeCount = activeByClass.get(cls.id) ?? 0;

    // Deliberately NOT `readSeatCount`: that helper takes `TransactionClientOnly`
    // and documents the Class row lock as a precondition (`capacity.ts:68`).
    //
    // This unlocked read is NOT the mistake #212 existed to remove, and the
    // difference is worth stating because it looks identical. #212's finding was
    // that an unlocked count is meaningless AS A GUARD — it moves the race
    // rather than closing it. This is not a guard. It decides only whether to
    // ASK, and `handleSpotFreed` re-counts through `readSeatCount` under
    // `lockClassRow` before it acts. Stale in either direction costs nothing:
    // reads full when free, the seat waits one more tick; reads free when full,
    // the hook's locked count suppresses it, as designed.
    //
    // It is therefore an equivalent mutant and has no mutation test. Said out
    // loud so the next reader does not mutation-test it, find nothing, and
    // conclude this suite is weak — the same reason `waitlist.ts:715` says it
    // about its own `waiting.length === 0` line.
    if (activeCount >= cls.maxStudents) continue;

    await handleSpotFreed(db, cls.id, opts.now);
    reconciled += 1;
  }

  return { candidates: classes.length, reconciled, failed: 0 };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Add the frozen-window test**

Append inside the `describe`:

```ts
  /**
   * Past the cancel deadline the queue is frozen and no promotion may happen —
   * the sweep must not become a way around that. `handleSpotFreed` would return
   * `{ action: 'frozen' }` anyway, so this pins the sweep's OWN filter: without
   * it the hook is invoked and `reconciled` counts a class that was never
   * reconcilable.
   */
  it('does not reconcile a class whose window has frozen', async () => {
    const cls = await makeClass(1);
    const filler = await makeStudent('FrozenFiller');
    const waiter = await makeStudent('FrozenWaiter');

    await prisma.registration.create({
      data: { classId: cls.id, studentId: filler, status: 'registered', tierAtBooking: 3 },
    });
    await addToWaitlist(prisma, cls.id, waiter);
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).frozen,
    });

    expect(summary.reconciled).toBe(0);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted).toBeNull();
  });
```

- [ ] **Step 6: Add the empty-class test — the `groupBy` trap**

Append inside the `describe`:

```ts
  /**
   * The class has a `waiting` entry and NO active registration at all, so it is
   * absent from the `registration.groupBy` result entirely. This is the one
   * fixture that distinguishes `activeByClass.get(id) ?? 0` from a lookup that
   * skips its misses — and the emptiest class is exactly the one most in need of
   * reconciling, so getting it backwards fails silently on the worst case.
   *
   * Reaching this state needs a hand-written entry: `addToWaitlist` requires the
   * class to be full, and a `maxStudents: 1` class with zero registrations is
   * not. That is legitimate here — the state is reachable in production by
   * cancelling the last registration, and this fixture is the state, not the
   * path to it.
   */
  it('reconciles a class with a waiting entry and no active registration', async () => {
    const cls = await makeClass(1);
    const waiter = await makeStudent('LoneWaiter');

    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiter, position: 1, status: 'waiting' },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
    });

    expect(summary.reconciled).toBe(1);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  });
```

- [ ] **Step 7: Add the end-to-end acceptance test for the auto-promote drop**

This is the test PR #218 could not write. First extend the top-level import — this
test is the file's first user of `handleSpotFreed`, and an unused import added
earlier would have failed lint:

```ts
import { addToWaitlist, handleSpotFreed } from './waitlist';
```

Then append inside the `describe`:

```ts
  /**
   * **The measured failure, end to end.** `promoteNext` runs in a bare
   * `db.$transaction(...)` with no options, so it carries Prisma's DEFAULT 5 s
   * interactive-transaction budget, while its first statement is an unbounded
   * inline `FOR UPDATE`. Held past 5 s it fails with `P2028` — measured at
   * 7014 ms against this exact 7 s hold, having waited out the entire hold and
   * failed afterwards.
   *
   * Baseline before the sweep existed, measured on 2026-08-13: entry still
   * `waiting`, registration `NONE`, 0 notifications. So the pre-sweep assertions
   * below are a recorded observation, not a guess.
   *
   * Note this is a DIFFERENT mechanism from the broadcast branch's 2 s
   * `lock_timeout` (`55P03`) — a Prisma client-side budget, not a Postgres one.
   */
  it('repairs an auto-promotion dropped by the transaction budget', async () => {
    const cls = await makeClass(1);
    const filler = await makeStudent('E2EFiller');
    const waiter = await makeStudent('E2EWaiter');
    const clocks = windowClocks(cls.startTime);

    await prisma.registration.create({
      data: { classId: cls.id, studentId: filler, status: 'registered', tierAtBooking: 3 },
    });
    await addToWaitlist(prisma, cls.id, waiter);
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    // A SEPARATE client, so the holder cannot share the caller's connection.
    const holderClient = new PrismaClient();
    let released = false;
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((r) => {
      signalHeld = r;
    });
    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        signalHeld();
        // Longer than Prisma's 5s default transaction budget, well inside
        // deleteStudentAccount's own 20s ceiling.
        await new Promise((r) => setTimeout(r, 7_000));
        released = true;
      },
      { timeout: 30_000 },
    );
    await lockHeld;

    const dropped = await handleSpotFreed(prisma, cls.id, clocks.autoPromote).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    await holder;
    await holderClient.$disconnect();

    // An outcome slowness cannot invent — derailer 3.
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.err).toMatch(/P2028|Transaction already closed/i);
    expect(released).toBe(true); // the hook waited the hold out, then failed

    // The measured baseline: nothing happened to the student.
    expect(
      await prisma.registration.findUnique({
        where: { classId_studentId: { classId: cls.id, studentId: waiter } },
      }),
    ).toBeNull();

    // And now the sweep repairs it.
    const summary = await reconcileWaitlists(prisma, { now: clocks.autoPromote });
    expect(summary.reconciled).toBe(1);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  }, 60_000);
```

- [ ] **Step 8: Run the whole file**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: PASS (4 tests). The last one takes ~7 s; that is the hold, not a hang.

- [ ] **Step 9: Prove the frozen filter bites**

Mutation: in `waitlist-reconciliation.ts`, delete the line `if (window === 'frozen') continue;`.

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: FAIL on `does not reconcile a class whose window has frozen`, at `expect(summary.reconciled).toBe(0)` receiving `1`.

**Record the exact assertion output**, then restore the line and re-run to confirm PASS. A guard you did not watch fail has certified nothing.

- [ ] **Step 10: Prove the `?? 0` default bites**

Mutation: change `activeByClass.get(cls.id) ?? 0` to `activeByClass.get(cls.id) ?? cls.maxStudents`. This is the realistic regression — a defaulting mistake, not a constant — and it is invisible to every test whose fixture happens to have another active registration.

Run the file. Expected: FAIL on `reconciles a class with a waiting entry and no active registration` only, with `summary.reconciled` `0` instead of `1`. The other three still pass, which is the point: without Step 6's fixture this mutation ships.

Record the output, restore, re-run.

- [ ] **Step 11: Commit**

```bash
git add src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "feat: a sweep that finds the classes whose spot-freed hook never delivered

Detection only — handleSpotFreed keeps deciding what to do, which is why the
auto-promote half is covered without a line addressing it. Includes the
end-to-end test PR 218 could not write: the row held past Prisma's 5s
transaction budget, the promotion dropped with P2028, and an assertion about
what the waiting student ends up with.

Two mutations recorded: the frozen filter, and the groupBy zero-default that
is only observable on a class with no other active registration.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The broadcast gate

**Files:**
- Modify: `src/services/waitlist-reconciliation.ts`
- Modify: `src/services/waitlist-reconciliation.test.ts`

**Interfaces:**
- Consumes: `DEADLINE_HOURS: Record<CancelDeadline, number>` from `./waitlist`, `classStartInstant(classDate: Date, startTime: string, timeZone: string): Date` from `@/lib/timezone`.
- Produces: no new exports. `reconcileWaitlists` gains a gate that only applies in the `first_come_first_claimed` window.

**Why this is a separate task:** the auto-promote branch needs no dedupe — a promotion fills the seat, so the trigger erases itself. Only the broadcast leaves state unchanged and could re-fire every minute. Reviewing that gate independently is worth a gate of its own.

- [ ] **Step 1: Write the failing test**

Append inside the `describe`:

```ts
  /**
   * The gate is EXACT, not approximate, and that follows from atomicity:
   * `createBulkNotifications` is one `createMany` with no `skipDuplicates` —
   * all-or-throw, per `waitlist.ts:732`. So "did any student get told?" and "did
   * every student get told?" are the same question, and a class-level check
   * answers it without a per-recipient query or a new column.
   *
   * `createdAt` is set explicitly — see derailer 1. The injected clock is in
   * 2099 and `@default(now())` would stamp 2026, which the gate's
   * `createdAt >= claimWindowStart` would correctly not see.
   */
  it('does not re-broadcast into a claim window that already has one', async () => {
    const cls = await makeClass(1);
    const filler = await makeStudent('GateFiller');
    const waiter = await makeStudent('GateWaiter');
    const clocks = windowClocks(cls.startTime);

    await prisma.registration.create({
      data: { classId: cls.id, studentId: filler, status: 'registered', tierAtBooking: 3 },
    });
    await addToWaitlist(prisma, cls.id, waiter);
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    // A broadcast that already went out, stamped inside the claim window.
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: waiter,
        type: 'spot_available',
        title: 'A spot opened up',
        body: 'already sent',
        relatedClassId: cls.id,
        createdAt: clocks.inClaimWindow,
      },
    });

    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    expect(summary.reconciled).toBe(0);
    expect(
      await prisma.notification.count({
        where: { relatedClassId: cls.id, type: 'spot_available' },
      }),
    ).toBe(1);
  });

  /**
   * The other half of the gate: with no prior broadcast in the window, the sweep
   * must still fire. Without this, a gate stuck permanently closed passes the
   * test above and delivers nothing — which is the bug this whole branch exists
   * to fix, reintroduced one level up.
   */
  it('broadcasts when the claim window has no notification yet', async () => {
    const cls = await makeClass(1);
    const filler = await makeStudent('OpenGateFiller');
    const waiter = await makeStudent('OpenGateWaiter');
    const clocks = windowClocks(cls.startTime);

    await prisma.registration.create({
      data: { classId: cls.id, studentId: filler, status: 'registered', tierAtBooking: 3 },
    });
    await addToWaitlist(prisma, cls.id, waiter);
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    expect(summary.reconciled).toBe(1);
    expect(
      await prisma.notification.count({
        where: { relatedClassId: cls.id, type: 'spot_available', recipientId: waiter },
      }),
    ).toBe(1);
  });
```

- [ ] **Step 2: Run and confirm both fail for the right reason**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: `does not re-broadcast…` FAILS with `reconciled` `1` instead of `0` and a notification count of `2` — there is no gate yet. `broadcasts when the claim window has no notification yet` should already PASS, since nothing is suppressing it. Confirm that split before implementing; if the second one fails, the fixture is wrong, not the gate.

- [ ] **Step 3: Implement the gate**

In `src/services/waitlist-reconciliation.ts`, extend the imports:

```ts
import type { CancelDeadline, PrismaClient } from '@prisma/client';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { classStartInstant } from '@/lib/timezone';
import { DEADLINE_HOURS, getWaitlistWindow, handleSpotFreed } from './waitlist';
```

Add this helper below `reconcileWaitlists`:

```ts
/**
 * True when this class's current claim window already carries a broadcast.
 *
 * Exact rather than approximate: the broadcast is one `createMany` with no
 * `skipDuplicates` (`waitlist.ts:732`), so a class's waiting students either all
 * received a `spot_available` notification or none did. There is no partial
 * state for a class-level check to be wrong about, and so no per-recipient query
 * and no new column.
 *
 * `claimWindowStart` is derived from the class rather than stored: it is
 * `classStart - (deadlineHours + 1) h`, the same boundary `getWaitlistWindow`
 * computes to decide the window in the first place.
 *
 * **The one race this does not close.** The read is outside the Class row lock,
 * so: this reads the gate → the live hook broadcasts → this invokes the hook →
 * a second broadcast. The sweep cannot race ITSELF (the `job.running` guard refuses a
 * tick while one is running), only the live path. The cost is one duplicate
 * notification against a current cost of no notification at all, and that trade
 * was made deliberately.
 */
async function alreadyBroadcastInWindow(
  db: PrismaClient,
  cls: {
    id: string;
    date: Date;
    startTime: string;
    cancelDeadline: CancelDeadline;
    teacher: { defaultTimezone: string };
  },
): Promise<boolean> {
  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const claimWindowStart = new Date(
    classStart.getTime() - (DEADLINE_HOURS[cls.cancelDeadline] + 1) * 60 * 60 * 1000,
  );

  const existing = await db.notification.findFirst({
    where: {
      relatedClassId: cls.id,
      type: 'spot_available',
      createdAt: { gte: claimWindowStart },
    },
    select: { id: true },
  });
  return existing !== null;
}
```

Then, inside the loop, between the capacity check and the `handleSpotFreed` call:

```ts
    // Only the broadcast needs a gate. A promotion fills the seat, so the
    // auto-promote branch erases its own trigger and cannot re-fire; a broadcast
    // leaves the seat free and would go out again every tick.
    if (
      window === 'first_come_first_claimed' &&
      (await alreadyBroadcastInWindow(db, cls))
    ) {
      continue;
    }
```

- [ ] **Step 4: Run and confirm all six pass**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Prove the gate bites**

Mutation: change `alreadyBroadcastInWindow`'s final line to `return false;`.

Run the file. Expected: FAIL on `does not re-broadcast into a claim window that already has one`, with the notification count `2` instead of `1`.

Record the output, restore, re-run.

- [ ] **Step 6: Prove the gate is not stuck shut**

Mutation: change that line to `return true;`.

Run the file. Expected: FAIL on `broadcasts when the claim window has no notification yet`, with `reconciled` `0` instead of `1`.

This is the mutation that matters most: a permanently-closed gate delivers nothing, which is the exact defect this branch exists to remove, reintroduced one level up. #136 shipped that shape — pins certifying a type nothing connected to the payload — and only the whole-branch review caught it.

Record the output, restore, re-run.

- [ ] **Step 7: Commit**

```bash
git add src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "feat: the broadcast gate, exact because the broadcast is atomic

A class-level check is normally the cheap approximation of a per-recipient
one. Here it is simply correct: createBulkNotifications is one createMany
with no skipDuplicates, so a class's waiting students either all got told or
none did. No new column, no migration, handleSpotFreed untouched.

Gated in both directions — one mutation proves it suppresses a second
broadcast, the other proves it is not stuck shut and delivering nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Per-class error isolation

**Files:**
- Modify: `src/services/waitlist-reconciliation.ts`
- Modify: `src/services/waitlist-reconciliation.test.ts`

**Interfaces:**
- Consumes: `log` from `@/lib/log`.
- Produces: `ReconcileSummary.failed` becomes meaningful (it has been hard-coded `0` since Task 1).

**Order note:** this task comes third because its test needs two candidate classes, one contended — cheapest to construct once detection and the gate both exist. `isolatedSweeps` isolates *sweeps from each other*, never *items within one sweep*, so without this one contended class abandons every class behind it in the loop.

- [ ] **Step 1: Write the failing test**

Append inside the `describe`:

```ts
  /**
   * Two candidates, the first held past `lockClassRow`'s 2 s bound so its
   * invocation throws `55P03`. The second must still be reconciled.
   *
   * `isolatedSweeps` (`lib/scheduler.ts:46`) wraps whole sweeps, not the items
   * inside one, so nothing outside this function protects the second class.
   *
   * The two classes are created in one call so both are candidates of the same
   * sweep; the loop order follows `class.findMany`, so this asserts on the
   * OUTCOME of both rather than on which ran first.
   *
   * One clock serves both, and that is safe rather than sloppy: `nextSlot()`
   * separates their start times by a minute or two, while the claim window is
   * 60 minutes wide and `inClaimWindow` sits 30 minutes from either edge. The
   * whole file creates fewer than a dozen classes, so the drift cannot approach
   * that margin. If you ever add enough classes for `nextSlot()` to roll an
   * hour, derive a clock per class instead.
   */
  it('reconciles the remaining classes when one loses its lock race', async () => {
    const blocked = await makeClass(1);
    const healthy = await makeClass(1);
    const clocks = windowClocks(blocked.startTime);

    for (const cls of [blocked, healthy]) {
      const filler = await makeStudent('IsoFiller');
      const waiter = await makeStudent('IsoWaiter');
      await prisma.registration.create({
        data: { classId: cls.id, studentId: filler, status: 'registered', tierAtBooking: 3 },
      });
      await addToWaitlist(prisma, cls.id, waiter);
      await prisma.registration.update({
        where: { classId_studentId: { classId: cls.id, studentId: filler } },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((r) => {
      signalHeld = r;
    });
    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${blocked.id} FOR UPDATE`;
        signalHeld();
        // Past lockClassRow's 2s bound, under Prisma's 5s default budget, so the
        // failure is 55P03 from Postgres rather than P2028 from the client.
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await lockHeld;

    // In the claim window, so the blocked class fails inside lockClassRow's
    // bounded wait rather than waiting the holder out.
    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    await holder;
    await holderClient.$disconnect();

    expect(summary.failed).toBe(1);
    expect(summary.reconciled).toBe(1);
    expect(
      await prisma.notification.count({
        where: { relatedClassId: healthy.id, type: 'spot_available' },
      }),
    ).toBe(1);
  }, 60_000);
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: FAIL on the new test — the `55P03` propagates out of `reconcileWaitlists` and the whole call rejects, so the test errors rather than asserting. Record the message.

- [ ] **Step 3: Implement isolation**

Add the import:

```ts
import { log } from '@/lib/log';
```

Replace the bare call in the loop:

```ts
    await handleSpotFreed(db, cls.id, opts.now);
    reconciled += 1;
```

with:

```ts
    try {
      await handleSpotFreed(db, cls.id, opts.now);
      reconciled += 1;
    } catch (err) {
      // Per class, mirroring `deleteStudentAccount`'s post-commit loop
      // (`gdpr.ts:654`). `isolatedSweeps` isolates sweeps from each other, NOT
      // items within one sweep — without this, one contended class abandons
      // every class behind it in this loop.
      //
      // `warn`, not `error`: `api-errors.ts:223` reserves `error` for what
      // should page someone, and losing a lock race is the system doing what it
      // was configured to do. This class is simply retried on the next tick,
      // which is what makes a separate retry unnecessary.
      failed += 1;
      log.warn({ err, classId: cls.id }, 'waitlist reconciliation failed for one class');
    }
```

Declare `let failed = 0;` beside `let reconciled = 0;`, and return it instead of the hard-coded zero:

```ts
  return { candidates: classes.length, reconciled, failed };
```

- [ ] **Step 4: Run and confirm all seven pass**

Run: `npx vitest run --project unit src/services/waitlist-reconciliation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Prove the isolation bites**

Mutation: remove the `try`/`catch`, leaving the bare `await handleSpotFreed(...)` and `reconciled += 1`.

Run the file. Expected: FAIL on `reconciles the remaining classes when one loses its lock race` — the rejection escapes `reconcileWaitlists` and the healthy class is never reached, so its notification count is `0`.

Record the output, restore, re-run.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "fix: one contended class must not abandon the rest of the sweep

isolatedSweeps isolates whole sweeps from each other, never the items inside
one, so nothing outside this loop protected the classes queued behind a
contended one. Per-class try/catch mirroring the gdpr post-commit loop, at
warn rather than error because a lost lock race is the system doing what it
was configured to do.

A class that fails is retried on the next tick, which is why this branch
needs no separate retry.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Register the job, and correct the docs it makes stale

**Files:**
- Modify: `src/lib/scheduler.ts` (the job table)
- Modify: `src/services/waitlist-reconciliation.ts` (the summary log line)
- Modify: `docs/lock-order.md`
- Modify: `docs/audits/2026-07-18-review-round-2.md:75`

**Interfaces:**
- Consumes: `reconcileWaitlists` from Task 1.
- Produces: a `waitlist-reconciliation` entry in `getJobHealth()`.

**Order note:** last, deliberately. Registering the job makes the sweep run against the dev database every minute; do not do it while the logic is incomplete.

- [ ] **Step 1: Add the summary log line**

At the end of `reconcileWaitlists`, before the `return`:

```ts
  if (reconciled > 0 || failed > 0) {
    // `info`, not `warn`: a reconciliation firing means the LIVE path failed and
    // this repaired it. That belongs in the record without paging anyone — the
    // `warn` lines at both `handleSpotFreed` call sites already record the
    // failure itself, and this records the repair.
    log.info(
      { candidates: classes.length, reconciled, failed },
      'waitlist reconciliation repaired at least one class',
    );
  }
```

- [ ] **Step 2: Register the job**

In `src/lib/scheduler.ts`, add to the dynamic-import block (~line 100):

```ts
  const { reconcileWaitlists } = await import('@/services/waitlist-reconciliation');
```

Add to the `jobs` array, after the `class-transitions` entry:

```ts
    {
      // 1 minute, and the cadence is load-bearing: the claim window is only 60
      // minutes wide, so this bounds a dropped broadcast's cost to roughly 1 of
      // the student's 60 claim minutes. At email-fallback's 5 minutes it would
      // be 8% of the window.
      //
      // Its own job name rather than a fourth sweep inside `class-transitions`,
      // so `getJobHealth()` and `/api/health` can tell a failing reconciliation
      // apart from a failing class transition.
      name: 'waitlist-reconciliation',
      intervalMs: 1 * MINUTE,
      run: (db) => reconcileWaitlists(db),
    },
```

- [ ] **Step 3: Verify the scheduler still typechecks and its own tests pass**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run --project unit src/lib/scheduler.test.ts`
Expected: PASS. If a test asserts the job count, update it to 6 and note the change in the commit body.

- [ ] **Step 4: Re-derive `docs/lock-order.md`'s caller count**

Run: `grep -rn "lockClassRow(" src | grep -v "\.test\.ts"`

Read the result and update the document's grep-3 sentence to match what you actually measured. **Do not copy a number from this plan** — the point of the exercise is that the count is re-derived, and it may have moved.

Check whether `src/services/capacity.ts:71-73` (which names `readSeatCount`'s callers) is still accurate. The sweep reaches `readSeatCount` only *through* `handleSpotFreed`, so it should still be true — confirm rather than assume, and leave it alone if so.

- [ ] **Step 5: Mark the audit observation answered**

In `docs/audits/2026-07-18-review-round-2.md`, at the "Fragile (untested invariants)" line reading `post-commit handleSpotFreed fire-and-forget (no sweep re-checks waitlists vs free seats)`, append that a sweep now does exactly this, naming `src/services/waitlist-reconciliation.ts`.

- [ ] **Step 6: Full verification**

Run: `npm run verify`

Expected: green. This runs typecheck, lint, and **all three vitest projects** — so a green result means the whole integration suite ran, not merely the unit tests. It needs the app already running on :3000; without it you get a wall of `ECONNREFUSED`, which means the server is not up, not that the branch is broken. **Do not start it yourself.**

Record the total test count from the output. It is needed for the PR body, where the arithmetic (`N = unit + components + integration`) turns "every integration file ran" from a reassurance into a checkable claim.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scheduler.ts src/services/waitlist-reconciliation.ts docs/lock-order.md docs/audits/2026-07-18-review-round-2.md
git commit -m "feat: register the reconciliation sweep, and answer a July audit line

Sixth scheduler job at 1 minute. The cadence is load-bearing rather than
conventional: the claim window is 60 minutes wide, so a 1-minute tick bounds
a dropped broadcast's cost to roughly one of the student's sixty claim
minutes.

docs/audits/2026-07-18-review-round-2.md line 75 observed that no sweep
re-checks waitlists against free seats. It was never filed. It is now
answered.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-review of this plan

**Spec coverage.** §4.1 signature → Task 1 Step 3 (with `opts.now`). §4.2 detection, batched `groupBy`, the `?? 0` default, the not-`readSeatCount` note → Task 1 Steps 3, 6, 10. §4.3 gate, its derivation of `claimWindowStart`, the accepted race → Task 2 Step 3. §4.4 error handling, registration, cadence, log levels → Tasks 3 and 4. §4.5 equivalent-mutant reasoning → Task 1 Step 3, as a code comment, and it is the one item with no mutation step, deliberately. §5's six tests map to T2/T5/groupBy (Task 1), T1/T3 (Task 2), T4 (Task 3). §6 documentation → Task 4 Steps 4-5.

**One deliberate deviation from §5.** The spec's table lists T1 as the broadcast acceptance test with a held row. Task 2's `broadcasts when the claim window has no notification yet` covers the broadcast path without the hold, and the held-row end-to-end proof is Task 1 Step 7 on the auto-promote branch. Adding a second 3.5 s hold to prove the same repair through a different failure mechanism buys one more mechanism and costs another slow test; Task 3's isolation test already exercises a `55P03` failure through the sweep. **If the PR reviewer wants both mechanisms proved end-to-end, add it — this is a judgement call, not an oversight.**

**No integration files are listed**, deliberately: the suite covers them, and naming them is what left 20 of 26 unobserved on #170. Task 4 Step 6 runs all three projects.

**Type consistency.** `ReconcileSummary` has the same three fields in Tasks 1, 3 and 4. `reconcileWaitlists(db, opts)` keeps its signature throughout. `alreadyBroadcastInWindow` is named identically in its definition, its call site, and both mutation steps. The `cls` object literal passed to it matches the `select` in Task 1's `class.findMany` field for field.

---

## Execution handoff

After Task 4, the branch is ready for `/pr-review-toolkit:review-pr`. The PR body must record: which of #220's inherited claims were checked and which held (all of them), the arithmetic behind the pricing numbers, the measured `P2028` finding and that it is **pre-existing rather than a #212 regression**, which suites ran with the test-count arithmetic, and the two limitations accepted by design (the duplicate-notification race in §4.3, and the double-failure-in-one-window case).

Write "**#N is unaffected**" for anything out of scope. Never the negated form of a closing keyword next to an issue number — it closes the issue.
