import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';
import { addToWaitlist, getWaitlistWindow, handleSpotFreed } from './waitlist';
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

function countSpotAvailable(classId: string): Promise<number> {
  return prisma.notification.count({
    where: { relatedClassId: classId, type: 'spot_available' },
  });
}

/**
 * Stamps a notification the SWEEP wrote into the 2099 claim window.
 *
 * Derailer 1: `Notification.createdAt` is `@default(now())`, so anything the
 * sweep writes during a test carries the database's 2026 clock while every
 * gate evaluates `createdAt >= claimWindowStart` in 2099. Without this, a
 * class the sweep has already broadcast to stays permanently
 * re-broadcastable, and any later sweep in a claim window tells its students
 * twice. In production both clocks are the same clock, so this exists only
 * because the tests inject one of them.
 */
function restampIntoWindow(classId: string, at: Date): Promise<unknown> {
  return prisma.notification.updateMany({
    where: { relatedClassId: classId, type: 'spot_available' },
    data: { createdAt: at },
  });
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
        email: `${suffix}-${label.toLowerCase()}-${studentIds.length}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    return student.id;
  }

  /**
   * The state this sweep exists for: a class that was full, one seat freed by
   * a cancel, and a student still queued.
   *
   * `maxStudents: 2` with one registration SURVIVING is the load-bearing part.
   * `registration.groupBy` emits no row for a class with no active
   * registrations, so a one-seat class emptied to zero is absent from the
   * result and exercises only the `?? 0` default. Every fixture in this file
   * used to be that class, which left `activeByClass.get(cls.id)` never once
   * returning a value and `activeCount >= cls.maxStudents` never once taken —
   * the batched pre-filter tested only in its empty case. With a survivor the
   * class lands IN the result with a count of 1 against 2 seats.
   *
   * The zero-active case is still covered, deliberately and now only, by
   * `reconciles a class with a waiting entry and no active registration`.
   *
   * `waiters` defaults to 1 because the auto-promote tests want a queue the
   * promotion empties. The BROADCAST tests pass 2: §4.3's argument that a
   * class-level gate is exact rests on `createBulkNotifications` being
   * all-or-none across the queue, and with a queue of one, "did any student get
   * told" and "did every student get told" are the same question — so a
   * one-waiter fixture cannot demonstrate the property the gate's correctness
   * depends on.
   */
  async function makeFreedSeat(
    label: string,
    opts: { waiters?: number } = {},
  ): Promise<{ id: string; startTime: string; waiter: string; waiters: string[] }> {
    const cls = await makeClass(2);
    const staying = await makeStudent(`${label}Staying`);
    const filler = await makeStudent(`${label}Filler`);

    for (const studentId of [staying, filler]) {
      await prisma.registration.create({
        data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
      });
    }
    // Full, so the joins below are legal.
    const waiters: string[] = [];
    for (let i = 0; i < (opts.waiters ?? 1); i += 1) {
      const waiter = await makeStudent(`${label}Waiter${i}`);
      await addToWaitlist(prisma, cls.id, waiter);
      waiters.push(waiter);
    }
    // Now free ONE seat without running the hook — this is the dropped state.
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    return { ...cls, waiter: waiters[0]!, waiters };
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
   * live hook never delivered. This proves the sweep repairs that state; the
   * two tests that CREATE the state by dropping a real hook are `repairs an
   * auto-promotion dropped by the transaction budget` (`P2028`) and
   * `reconciles the remaining classes when one loses its lock race`
   * (`55P03`).
   */
  it('promotes the queue head of a class with a free seat', async () => {
    const cls = await makeFreedSeat('Head');

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
    });

    // `reconciledClassIds`, not `reconciled`, throughout this file: the sweep
    // is database-wide, so an exact count is a claim about every row in
    // `ethical_yoga_test` — including any a killed run left behind — while
    // this asserts the outcome for the class the test built. Stricter and
    // narrower at once.
    expect(summary.reconciledClassIds).toContain(cls.id);
    expect(summary.repairedClassIds).toContain(cls.id);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: cls.waiter } },
    });
    expect(promoted?.status).toBe('registered');
  });

  /**
   * The class has a `waiting` entry and NO active registration at all, so it is
   * absent from the `registration.groupBy` result entirely. This is the one
   * fixture that distinguishes `activeByClass.get(id) ?? 0` from a lookup that
   * skips its misses — and the emptiest class is exactly the one most in need of
   * reconciling, so getting it backwards fails silently on the worst case.
   *
   * "The one fixture" is a claim `makeFreedSeat` is what makes true. Every
   * other class in this file keeps a surviving registration and therefore
   * appears in the `groupBy` result, where the default is never consulted.
   * Before that, every fixture was zero-active and the `?? cls.maxStudents`
   * mutation failed three tests instead of this one — a mutation that fails
   * everywhere localises nothing.
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

    expect(summary.reconciledClassIds).toContain(cls.id);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  });

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
    const cls = await makeFreedSeat('E2E');
    const waiter = cls.waiter;
    const clocks = windowClocks(cls.startTime);

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
    // Snapshotted BEFORE `await holder`, which is the whole assertion. Read
    // after it, `released` is `true` unconditionally — the holder's body sets it
    // as its last statement, so awaiting the holder guarantees the value and the
    // check cannot fail. The precedent is `waitlist.test.ts:1681`, which asserts
    // its own flag before awaiting for exactly this reason.
    const releasedWhenHookReturned = released;
    await holder;
    await holderClient.$disconnect();

    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.err).toMatch(/P2028|Transaction already closed/i);

    // The ordering claim, and the one assertion here that slowness cannot
    // manufacture. `P2028` alone would not do it: unlike `55P03` — which
    // Postgres raises only when a statement is genuinely blocked on a lock —
    // `P2028` is a client-side wall-clock verdict, and a machine slow enough to
    // burn 5s inside `promoteNext` produces it with no lock involved. What rules
    // that out is that the holder had already finished its 7s body when the hook
    // returned: the hook outlived the hold rather than timing out beside it.
    // Delete `lockClassRow`'s contention and an unblocked `promoteNext` returns
    // in milliseconds with `released` still false.
    expect(releasedWhenHookReturned).toBe(true);

    // The measured baseline: nothing happened to the student.
    expect(
      await prisma.registration.findUnique({
        where: { classId_studentId: { classId: cls.id, studentId: waiter } },
      }),
    ).toBeNull();

    // And now the sweep repairs it.
    const summary = await reconcileWaitlists(prisma, { now: clocks.autoPromote });
    expect(summary.reconciledClassIds).toContain(cls.id);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  }, 60_000);

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
    const cls = await makeFreedSeat('Gate', { waiters: 2 });
    const clocks = windowClocks(cls.startTime);

    // A broadcast that already went out, stamped inside the claim window.
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: cls.waiter,
        type: 'spot_available',
        title: 'A spot opened up',
        body: 'already sent',
        relatedClassId: cls.id,
        createdAt: clocks.inClaimWindow,
      },
    });

    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    expect(summary.reconciledClassIds).not.toContain(cls.id);
    expect(await countSpotAvailable(cls.id)).toBe(1);
  });

  /**
   * The other half of the gate: with no prior broadcast in the window, the sweep
   * must still fire. Without this, a gate stuck permanently closed passes the
   * test above and delivers nothing — which is the bug this whole branch exists
   * to fix, reintroduced one level up.
   */
  it('broadcasts when the claim window has no notification yet', async () => {
    const cls = await makeFreedSeat('OpenGate', { waiters: 2 });
    const clocks = windowClocks(cls.startTime);

    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    expect(summary.reconciledClassIds).toContain(cls.id);
    expect(summary.repairedClassIds).toContain(cls.id);

    // EVERY waiting student, not merely some student. With one waiter this and
    // the gate's "did any student get told" collapse into the same assertion,
    // and the all-or-none property §4.3 rests on goes unproved.
    expect(await countSpotAvailable(cls.id)).toBe(2);
    for (const waiter of cls.waiters) {
      expect(
        await prisma.notification.count({
          where: { relatedClassId: cls.id, type: 'spot_available', recipientId: waiter },
        }),
      ).toBe(1);
    }

    await restampIntoWindow(cls.id, clocks.inClaimWindow);
  });

  /**
   * The gate's lower bound, which nothing else pins: delete
   * `createdAt: { gte: claimWindowStart }` and every other test in this file
   * still passes, because each one either has no prior notification or has one
   * inside the window. Only a notification stamped OUTSIDE the window
   * distinguishes "already broadcast in THIS window" from "has ever been
   * broadcast to".
   *
   * Reachable in production: `date` and `startTime` are absent from
   * `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so a class can be rescheduled
   * after its settings lock. That opens a new claim window while the old
   * `spot_available` rows persist, and without the bound the gate would be shut
   * forever for that class — this branch's own defect, reintroduced for
   * rescheduled classes.
   */
  it('broadcasts despite a notification stamped before the claim window', async () => {
    const cls = await makeFreedSeat('OldNote');
    const clocks = windowClocks(cls.startTime);

    // Six hours before `claimWindowStart`, which sits at classStart − 25h.
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: cls.waiter,
        type: 'spot_available',
        title: 'A spot opened up',
        body: 'sent in a previous, since-rescheduled window',
        relatedClassId: cls.id,
        createdAt: new Date(clocks.classStart.getTime() - 31 * H),
      },
    });

    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    expect(summary.reconciledClassIds).toContain(cls.id);
    expect(await countSpotAvailable(cls.id)).toBe(2); // the stale one, plus a fresh one

    await restampIntoWindow(cls.id, clocks.inClaimWindow);
  });

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
    const blocked = await makeFreedSeat('IsoBlocked', { waiters: 2 });
    const healthy = await makeFreedSeat('IsoHealthy', { waiters: 2 });
    const clocks = windowClocks(blocked.startTime);

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

    expect(summary.failedClassIds).toContain(blocked.id);
    expect(summary.reconciledClassIds).not.toContain(blocked.id);
    expect(summary.reconciledClassIds).toContain(healthy.id);
    expect(await countSpotAvailable(healthy.id)).toBe(2);

    // Derailer 1, before the retry rather than at the end of the test: the
    // sweep's own broadcast to `healthy` is 2026-stamped and invisible to the
    // 2099 gate, so without this the retry below tells `healthy` a second
    // time. Stamping it here means the retry ALSO proves the gate suppresses
    // a class that has already been told, in a live sweep rather than a
    // hand-written fixture.
    await restampIntoWindow(healthy.id, clocks.inClaimWindow);

    // **Spec §8 acceptance 1**, which the plan's self-review left to review:
    // a class whose live broadcast was dropped by a lock timeout has its
    // waiting students notified. Everything above proves the sweep SURVIVES a
    // `55P03`; this proves it REPAIRS one. The holder has released, so the
    // retry takes the lock on the class that lost the race a moment ago.
    //
    // The auto-promote half is proved end-to-end by `repairs an
    // auto-promotion dropped by the transaction budget` through a different
    // mechanism (`P2028`, a Prisma client-side budget). This is the Postgres
    // `lock_timeout` half — the one #220 was actually filed about.
    const repair = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow });

    expect(repair.reconciledClassIds).toContain(blocked.id);
    expect(repair.repairedClassIds).toContain(blocked.id);
    expect(repair.failedClassIds).not.toContain(blocked.id);
    expect(await countSpotAvailable(blocked.id)).toBe(2); // both waiters, all-or-none
    expect(await countSpotAvailable(healthy.id)).toBe(2); // gated, not told twice

    await restampIntoWindow(blocked.id, clocks.inClaimWindow);
  }, 60_000);

  /**
   * An invocation that repairs nothing, which is what separates
   * `repairedClassIds` from `reconciledClassIds`. Without this test
   * `repairedClassIds.push(cls.id)` unconditionally survives, and a sweep that
   * invoked the hook fifty times and fixed nothing would log `repaired: 50` —
   * inverting the one operator signal the split exists to provide.
   *
   * The state: a student holding BOTH an active registration and a `waiting`
   * entry, which `promoteNext`'s head loop (`waitlist.ts:423-437`) exists to
   * drain. It marks the stale head `removed`, finds no successor, and returns
   * `null` → `{ action: 'none' }`. The class is invoked and the queue is
   * cleaned, but no seat changes hands.
   */
  it('counts an invocation that repairs nothing as reconciled but not repaired', async () => {
    const cls = await makeClass(2);
    const student = await makeStudent('Stale');

    await prisma.registration.create({
      data: { classId: cls.id, studentId: student, status: 'registered', tierAtBooking: 3 },
    });
    // Stale by construction: the same student is registered AND queued.
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: student, position: 1, status: 'waiting' },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
    });

    expect(summary.reconciledClassIds).toContain(cls.id);
    expect(summary.repairedClassIds).not.toContain(cls.id);

    // And the queue drained itself, so the trigger cannot re-fire forever.
    const entry = await prisma.waitlistEntry.findFirst({ where: { classId: cls.id } });
    expect(entry?.status).toBe('removed');
  });

  /**
   * A class that is not `open` is never reconciled, however free its seats.
   *
   * Two things enforce this — the `class: { status: 'open' }` join on the
   * candidate query and the `status: 'open'` filter on the class read — so this
   * test pins the OUTCOME rather than either mechanism; removing one alone
   * leaves it green. That is deliberate. The join's job is bounding the
   * candidate set, which is a cost property no unit test can observe; the
   * filter's job is correctness, and this is what pins it.
   *
   * The state is reachable and documented: `gdpr.ts` records a residual where
   * `waiting` entries survive on a class that can never promote anyone, and
   * neither `completeClass` nor `startClass` closes a queue.
   */
  it('does not reconcile a class that is no longer open', async () => {
    const cls = await makeClass(2);
    const waiter = await makeStudent('ClosedClass');

    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiter, position: 1, status: 'waiting' },
    });
    await prisma.class.update({ where: { id: cls.id }, data: { status: 'cancelled' } });

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
    });

    expect(summary.reconciledClassIds).not.toContain(cls.id);
    expect(summary.failedClassIds).not.toContain(cls.id);
    expect(
      await prisma.registration.findUnique({
        where: { classId_studentId: { classId: cls.id, studentId: waiter } },
      }),
    ).toBeNull();
  });

  /**
   * **The production call path**, which no other test in this file touches:
   * `reconcileWaitlists(prisma)` with no `opts`, exactly as `scheduler.ts:144`
   * invokes it.
   *
   * Two things only this shape can prove. First, the default-parameter path —
   * thread `opts.now ?? new Date(0)` through the module and every other test
   * stays green while production resolves every class to `auto_promote` and the
   * broadcast branch never runs again. Second, and subtler: every other test
   * gates against a `createdAt` the TEST wrote, because the injected 2099 clock
   * and the database's `@default(now())` disagree (derailer 1) and
   * `restampIntoWindow` papers over it. Here both clocks are the same clock, as
   * they are in production, so the sequence "sweep broadcasts on tick N, is
   * gated on tick N+1" is exercised for real.
   *
   * The class is built in the ACTUAL future and its window is asserted rather
   * than assumed, so a boundary error shows up as a failed precondition instead
   * of a mysteriously quiet sweep.
   */
  it('broadcasts once, then gates itself, on the real clock with no injected now', async () => {
    const target = new Date(Date.now() + 24.5 * H);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(target);
    const at = (t: string) => parts.find((p) => p.type === t)!.value;
    const startTime = `${at('hour')}:${at('minute')}`;
    const date = new Date(`${at('year')}-${at('month')}-${at('day')}`);

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date,
        startTime,
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 2,
        status: 'open',
        cancelDeadline: 'HOURS_24',
        settingsLocked: true,
      },
    });
    classIds.push(cls.id);

    // Precondition, asserted rather than assumed — and it caught the offset
    // being wrong the first time. With a 24h deadline the claim window is
    // `[start − 25h, start − 24h)`, so `now` must sit inside it: the class
    // starts 24.5h out, not 25.5h, which is half an hour the wrong side of the
    // opening edge. Resolved with no `now`, like the sweep.
    expect(getWaitlistWindow(date, startTime, 'HOURS_24', TZ)).toBe('first_come_first_claimed');

    const staying = await makeStudent('RealStaying');
    const filler = await makeStudent('RealFiller');
    const waiter = await makeStudent('RealWaiter');
    for (const studentId of [staying, filler]) {
      await prisma.registration.create({
        data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
      });
    }
    await addToWaitlist(prisma, cls.id, waiter);
    await prisma.registration.update({
      where: { classId_studentId: { classId: cls.id, studentId: filler } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const first = await reconcileWaitlists(prisma);
    expect(first.repairedClassIds).toContain(cls.id);
    expect(await countSpotAvailable(cls.id)).toBe(1);

    // No restamp: the gate now reads a timestamp the DATABASE wrote.
    const second = await reconcileWaitlists(prisma);
    expect(second.reconciledClassIds).not.toContain(cls.id);
    expect(await countSpotAvailable(cls.id)).toBe(1);
  });

  /**
   * Past the cancel deadline the queue is frozen and no promotion may happen —
   * the sweep must not become a way around that. `handleSpotFreed` would return
   * `{ action: 'frozen' }` anyway, so this pins the sweep's OWN filter: without
   * it the hook is invoked and `reconciled` counts a class that was never
   * reconcilable.
   *
   * Still runs last, but no longer because anything depends on it. A frozen
   * class is left with a free seat and a `waiting` entry, so it stays a
   * reconcilable candidate for every later sweep — which used to inflate
   * their `reconciled` counts. Scoping every assertion to its own class ids
   * removed that coupling; the ordering is now convention rather than a
   * load-bearing constraint, and moving this test would break nothing.
   */
  it('does not reconcile a class whose window has frozen', async () => {
    const cls = await makeFreedSeat('Frozen');

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).frozen,
    });

    // `not.toContain`, not `reconciled === 0`: the filter under test is about
    // THIS class, and a leftover row elsewhere in the test database must not
    // be able to turn that verdict into a failure — nor, worse, into a pass.
    expect(summary.reconciledClassIds).not.toContain(cls.id);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: cls.waiter } },
    });
    expect(promoted).toBeNull();
  });
});
