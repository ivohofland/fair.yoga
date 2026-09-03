import { describe, it, beforeAll, afterAll, expect, vi, onTestFinished } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { classStartInstant } from '@/lib/timezone';
import { hhmmToTime } from '@/lib/time-of-day';
import {
  addToWaitlist,
  claimSpot,
  getWaitlistWindow,
  handleSpotFreed,
  SpotFreedError,
} from './waitlist';
import {
  ReconciliationFailedError,
  createReconciliationStreaks,
  reconcileWaitlists,
  runWaitlistReconciliationTick,
} from './waitlist-reconciliation';
import { createClassFixture } from '../../tests/class-fixtures';

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
  const classStart = classStartInstant({ date: CLASS_DATE, startTime: hhmmToTime(startTime) }, TZ);
  return {
    classStart,
    autoPromote: new Date(classStart.getTime() - 48 * H),
    inClaimWindow: new Date(classStart.getTime() - 24.5 * H),
    frozen: new Date(classStart.getTime() - 12 * H),
  };
}

/**
 * Per RECIPIENT, not per class.
 *
 * The class-wide `count(...)).toBe(2)` form this file used to use was the
 * single largest source of flakiness in it: the sweep is database-wide, so any
 * leftover row or any concurrent run changed the number, and the assertions
 * that broke were exactly these. Scoping to a student the test created makes
 * the assertion immune to rows it did not write, which is the same argument
 * the summary type makes for ids over counts.
 */
function spotNotifications(classId: string, studentId: string): Promise<number> {
  return prisma.notification.count({
    where: { relatedClassId: classId, type: 'spot_available', recipientId: studentId },
  });
}

/** `Class.spotBroadcastAt` — the gate itself, read directly. */
async function broadcastFlag(classId: string): Promise<Date | null> {
  const cls = await prisma.class.findUniqueOrThrow({
    where: { id: classId },
    select: { spotBroadcastAt: true },
  });
  return cls.spotBroadcastAt;
}

describe('reconcileWaitlists (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  const classIds: string[] = [];
  const studentIds: string[] = [];
  let slotCounter = 0;

  /**
   * Distinct `HH:MM` per class. `CalendarEntry_teacher_slot_excl` is a RANGE
   * overlap per teacher, so a minute apart is only disjoint because every
   * fixture here is `durationMinutes: 1` — see the call site, which says why.
   */
  function nextSlot(): string {
    slotCounter += 1;
    return `${String(10 + Math.floor(slotCounter / 60)).padStart(2, '0')}:${String(
      slotCounter % 60,
    ).padStart(2, '0')}`;
  }

  async function makeClass(maxStudents: number): Promise<{ id: string; startTime: string }> {
    const startTime = nextSlot();
    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: CLASS_DATE,
        startTime: hhmmToTime(startTime),
        // ONE MINUTE (#327): `nextSlot` spaces fixtures a minute apart, and
        // the slot constraint is a range overlap now — so a 60-minute fixture
        // collides with the one before it. Nothing here reads the duration;
        // the cancel-deadline window these tests turn on is computed from the
        // START.
        durationMinutes: 1,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents,
        status: 'open',
        cancelDeadline: 'HOURS_24',
        settingsLocked: true,
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
   * promotion empties. Tests that need the all-or-none broadcast property pass
   * 2: with a queue of one, "did any student get told" and "did every student
   * get told" are the same question, so a one-waiter fixture cannot demonstrate
   * it. Not every broadcast-window test needs that property — the ones probing
   * the GATE rather than the fan-out take the default.
   *
   * Registrations are written directly rather than through
   * `activateRegistration`, so the fixture never touches `spotBroadcastAt` and
   * every class starts with a null flag — an open gate.
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
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
   * auto-promotion dropped by the 2s lock bound` and `reconciles the
   * remaining classes when one loses its lock race` — both `55P03` now, one
   * per branch of `handleSpotFreed` (auto-promote, broadcast).
   */
  it('promotes the queue head of a class with a free seat', async () => {
    const cls = await makeFreedSeat('Head');

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
      streaks: createReconciliationStreaks(),
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
      streaks: createReconciliationStreaks(),
    });

    expect(summary.reconciledClassIds).toContain(cls.id);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  });

  /**
   * **The measured failure, end to end.** `promoteNext` (#104) now takes its
   * class row lock through `lockClassRow`, so its first statement carries the
   * shared 2s `SET LOCAL lock_timeout` rather than an unbounded inline `FOR
   * UPDATE`. Held past 2s it fails with `55P03` — Postgres cancelling the
   * blocked statement itself, the same mechanism the broadcast branch already
   * exercises below (`reconciles the remaining classes when one loses its
   * lock race`). Only the mechanism converged: this test still exercises the
   * auto-promote branch of `handleSpotFreed`, that one the broadcast branch,
   * and that split is what the sweep's design rests on.
   *
   * HISTORICAL, kept rather than deleted: before this conversion, the same
   * scenario at a 7 s hold measured 7014 ms and failed with `P2028` instead —
   * `promoteNext` ran in a bare `db.$transaction(...)` carrying Prisma's
   * default 5 s interactive-transaction budget, and Prisma waited out the
   * entire hold before noticing its own wall-clock budget had been blown,
   * because its timeout cannot cancel a statement already blocked inside
   * Postgres, only refuse to start a new one. That claim is unchanged by this
   * conversion and is still relied on by `deleteStudentAccount` (`gdpr.ts`)
   * and by spec §3.1 — this measurement is its evidence.
   *
   * Baseline before the sweep existed, measured on 2026-08-13: entry still
   * `waiting`, registration `NONE`, 0 notifications. So the pre-sweep assertions
   * below are a recorded observation, not a guess.
   */
  it('repairs an auto-promotion dropped by the 2s lock bound', async () => {
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
        // Past lockClassRow's 2s bound, under Prisma's 5s default budget, so
        // the failure is 55P03 from Postgres rather than P2028 from the
        // client.
        await new Promise((r) => setTimeout(r, 3_500));
        released = true;
      },
      { timeout: 30_000 },
    );
    await lockHeld;

    const dropped = await handleSpotFreed(prisma, cls.id, clocks.autoPromote).then(
      () => ({ ok: true as const }),
      // `handleSpotFreed` wraps every throw in `SpotFreedError` — the Postgres
      // error this test is about (see the docblock above) lives on `.cause`,
      // not the wrapper's own message.
      (err: unknown) => ({
        ok: false as const,
        err: err instanceof SpotFreedError ? String(err.cause) : String(err),
      }),
    );
    // Snapshotted BEFORE `await holder`, because read after it the flag is
    // `true` unconditionally — the holder's body sets it as its last
    // statement. So the early read is what makes `toBe(false)` below
    // expressible at all.
    //
    // It is NOT what makes this test bite, and an earlier version of this
    // comment argued that it was, on the grounds that a late read "cannot
    // fail". That reasoning was inherited from the old `toBe(true)` pin, where
    // the early read genuinely WAS the claim. Under `toBe(false)` it inverts:
    // reading late is the only arrangement in which this check could fail, so
    // "cannot fail" is an argument against an assertion, never for it. What
    // carries the weight now is the SQLSTATE — see below.
    const releasedWhenHookReturned = released;
    await holder;
    await holderClient.$disconnect();

    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.err).toMatch(/55P03/);

    // `dropped.err` above is what carries this test: only a `lock_timeout`
    // produces `55P03`, so matching it names the mechanism as Postgres
    // cancelling the blocked statement itself once `lockClassRow`'s 2s bound
    // elapses — the opposite of the old `P2028`, which waited out the whole
    // hold and only then noticed its own budget was blown.
    //
    // The flag below CORROBORATES the ordering that mechanism implies: the
    // hook came back before the holder's 3.5s hold ended, not after it. It is
    // not an independent claim. Every regression that would flip it to `true`
    // flips `dropped.ok` first, because a wait that reaches 3.5s acquires the
    // row and SUCCEEDS rather than failing late.
    expect(releasedWhenHookReturned).toBe(false);

    // The measured baseline: nothing happened to the student.
    expect(
      await prisma.registration.findUnique({
        where: { classId_studentId: { classId: cls.id, studentId: waiter } },
      }),
    ).toBeNull();

    // And now the sweep repairs it.
    const summary = await reconcileWaitlists(prisma, {
      now: clocks.autoPromote,
      streaks: createReconciliationStreaks(),
    });
    expect(summary.reconciledClassIds).toContain(cls.id);
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: waiter } },
    });
    expect(promoted?.status).toBe('registered');
  }, 60_000);

  /**
   * The gate, closed. `Class.spotBroadcastAt` stands for the seat that is
   * currently free, so the sweep must not announce it again every tick.
   *
   * The flag is written directly here rather than by running a broadcast: this
   * test is about the gate reading it, and `re-broadcasts once a claim has
   * consumed the seat` is the one that proves a real broadcast sets it.
   */
  it('does not re-broadcast while a broadcast still stands', async () => {
    const cls = await makeFreedSeat('Gate', { waiters: 2 });
    const clocks = windowClocks(cls.startTime);

    await prisma.class.update({
      where: { id: cls.id },
      data: { spotBroadcastAt: clocks.inClaimWindow },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(summary.reconciledClassIds).not.toContain(cls.id);
    // The REASON, not merely the absence. `not.toContain` alone passes when the
    // class was skipped for entirely the wrong reason — frozen, or read as
    // full — which is what makes the reason list worth carrying per class.
    expect(summary.skipped).toContainEqual({ classId: cls.id, reason: 'already_broadcast' });
    for (const waiter of cls.waiters) {
      expect(await spotNotifications(cls.id, waiter)).toBe(0);
    }
  });

  /**
   * The other half of the gate: with no broadcast standing, the sweep must
   * still fire. Without this, a gate stuck permanently closed passes the test
   * above and delivers nothing — which is the bug this whole branch exists to
   * fix, reintroduced one level up.
   */
  it('broadcasts when no broadcast stands, and records that one now does', async () => {
    const cls = await makeFreedSeat('OpenGate', { waiters: 2 });
    const clocks = windowClocks(cls.startTime);

    expect(await broadcastFlag(cls.id)).toBeNull();

    const summary = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(summary.reconciledClassIds).toContain(cls.id);
    expect(summary.repairedClassIds).toContain(cls.id);

    // EVERY waiting student, not merely some student. With one waiter this and
    // the gate's "did any student get told" collapse into the same assertion,
    // and the all-or-none property the class-level gate rests on goes unproved.
    for (const waiter of cls.waiters) {
      expect(await spotNotifications(cls.id, waiter)).toBe(1);
    }
    // The broadcast set the flag, in the same transaction as the notifications.
    expect(await broadcastFlag(cls.id)).toEqual(clocks.inClaimWindow);
  });

  /**
   * **The sequence the window-keyed gate could not repair, and the reason
   * `spotBroadcastAt` exists.**
   *
   * One claim window is sixty minutes wide and can hold more than one
   * seat-freeing event. Seat frees → broadcast succeeds → a waiter CLAIMS →
   * the seat frees again → the live hook drops the second broadcast. The old
   * gate asked "is there a `spot_available` notification inside this claim
   * window", found the first one, and suppressed the sweep for the rest of the
   * hour: the remaining waiter was never told, in exactly the state the sweep
   * exists to repair.
   *
   * What makes the flag correct is that `claimSpot` reaches
   * `activateRegistration`, which clears it. The seat the broadcast announced
   * is gone, so the broadcast no longer stands. Nothing here writes the flag by
   * hand — the claim does it, through the production path.
   */
  it('re-broadcasts once a claim has consumed the seat and another frees', async () => {
    const cls = await makeFreedSeat('SecondSeat', { waiters: 2 });
    const clocks = windowClocks(cls.startTime);
    const [first, second] = cls.waiters as [string, string];

    // Round one: the live broadcast goes out and the flag stands.
    const opened = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });
    expect(opened.repairedClassIds).toContain(cls.id);
    expect(await broadcastFlag(cls.id)).not.toBeNull();

    // The first waiter claims the seat — the class is full again, and the
    // broadcast that announced that seat no longer stands for anything.
    await claimSpot(prisma, cls.id, first, clocks.inClaimWindow);
    expect(await broadcastFlag(cls.id)).toBeNull();

    // A second seat frees, and the live hook drops it (simulated by simply not
    // running it — the two lock-race tests prove a real drop lands here).
    await prisma.registration.updateMany({
      where: { classId: cls.id, studentId: first },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await prisma.waitlistEntry.updateMany({
      where: { classId: cls.id, studentId: second },
      data: { status: 'waiting' },
    });

    const repaired = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(repaired.repairedClassIds).toContain(cls.id);
    // The second waiter is told about the second seat. Under the window-keyed
    // gate this was 1 — the first broadcast only — and stayed 1 forever.
    expect(await spotNotifications(cls.id, second)).toBe(2);
  });

  /**
   * The claim-window lower bound, which nothing else pins: delete
   * `cls.spotBroadcastAt >= claimWindowStart` and every other test in this file
   * still passes, because each one either has no standing broadcast or has one
   * inside the window. Only a flag stamped OUTSIDE the window distinguishes
   * "a broadcast stands for the CURRENT window" from "a broadcast has ever
   * stood".
   *
   * Reachable in production: `date` and `startTime` are absent from
   * `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so a class can be rescheduled
   * after its settings lock. That opens a new claim window while the old flag
   * persists, and without the bound the gate would be shut forever for that
   * class — this branch's own defect, reintroduced for rescheduled classes.
   */
  it('broadcasts despite a broadcast flag stamped before the claim window', async () => {
    const cls = await makeFreedSeat('OldFlag');
    const clocks = windowClocks(cls.startTime);

    // Six hours before `claimWindowStart`, which sits at classStart − 25h.
    await prisma.class.update({
      where: { id: cls.id },
      data: { spotBroadcastAt: new Date(clocks.classStart.getTime() - 31 * H) },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(summary.reconciledClassIds).toContain(cls.id);
    expect(await spotNotifications(cls.id, cls.waiter)).toBe(1);
  });

  /**
   * Two candidates, the first held past `lockClassRow`'s 2 s bound so its
   * invocation throws `55P03`. The second must still be reconciled.
   *
   * `isolatedSweeps` (`lib/scheduler.ts`) wraps whole sweeps, not the items
   * inside one, so nothing outside `reconcileOne` protects the second class.
   *
   * The two classes are created in one call so both are candidates of the same
   * sweep; the loop order is `orderBy: { id: 'asc' }`, so this asserts on the
   * OUTCOME of both rather than on which ran first.
   *
   * One clock serves both, and that is safe rather than sloppy: `nextSlot()`
   * separates their start times by a minute or two, while the claim window is
   * 60 minutes wide and `inClaimWindow` sits 30 minutes from either edge. The
   * whole file creates fewer than two dozen classes, so the drift cannot
   * approach that margin. If you ever add enough classes for `nextSlot()` to
   * roll an hour, derive a clock per class instead.
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
    const summary = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    await holder;
    await holderClient.$disconnect();

    expect(summary.failedClassIds).toContain(blocked.id);
    expect(summary.reconciledClassIds).not.toContain(blocked.id);
    expect(summary.reconciledClassIds).toContain(healthy.id);
    for (const waiter of healthy.waiters) {
      expect(await spotNotifications(healthy.id, waiter)).toBe(1);
    }

    // **Spec §8 acceptance 1**: a class whose live broadcast was dropped by a
    // lock timeout has its waiting students notified. Everything above proves
    // the sweep SURVIVES a `55P03`; this proves it REPAIRS one. The holder has
    // released, so the retry takes the lock on the class that lost the race a
    // moment ago.
    //
    // The auto-promote half is proved end-to-end by `repairs an auto-promotion
    // dropped by the 2s lock bound` through the same `55P03` `lock_timeout`
    // mechanism, on the other branch of `handleSpotFreed`. This test is the
    // one #220 was actually filed about.
    const repair = await reconcileWaitlists(prisma, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(repair.reconciledClassIds).toContain(blocked.id);
    expect(repair.repairedClassIds).toContain(blocked.id);
    expect(repair.failedClassIds).not.toContain(blocked.id);
    for (const waiter of blocked.waiters) {
      expect(await spotNotifications(blocked.id, waiter)).toBe(1);
    }
    // `healthy` broadcast on the first sweep and nothing has claimed its seat,
    // so its flag still stands and the second sweep must leave it alone. No
    // clock fixing-up is needed for that to hold: the flag was written from the
    // same injected `now` the gate compares against.
    expect(repair.skipped).toContainEqual({ classId: healthy.id, reason: 'already_broadcast' });
    for (const waiter of healthy.waiters) {
      expect(await spotNotifications(healthy.id, waiter)).toBe(1);
    }
  }, 60_000);

  /**
   * An invocation that repairs nothing, which is what separates
   * `repairedClassIds` from `reconciledClassIds`. Without this test
   * `repaired: true` unconditionally survives, and a sweep that invoked the
   * hook fifty times and fixed nothing would log `repaired: 50` — inverting the
   * one operator signal the split exists to provide.
   *
   * The state: a student holding BOTH an active registration and a `waiting`
   * entry, which `promoteNext`'s head loop exists to drain. It marks the stale
   * head `removed`, finds no successor, and returns `null` → `{ action:
   * 'none' }`. The class is invoked and the queue is cleaned, but no seat
   * changes hands.
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
      streaks: createReconciliationStreaks(),
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
   * leaves it green, and that is worth saying plainly because an earlier
   * revision of this comment claimed the filter was pinned and it is not. The
   * join's job is bounding the candidate set, a cost property no unit test can
   * observe; the filter's job is correctness against a class that completes
   * between the two queries, a race no test enters. The outcome is what both
   * exist for and the only thing worth asserting here.
   *
   * The state is reachable, though less often than when this was written:
   * `closeQueueOnStart` (#216) now closes the queue at all three
   * `open -> in_progress` exits, `completeClass`'s inline bump included, so a
   * class that simply RAN no longer leaves `waiting` rows behind. What remains
   * are rows predating that change, and any future path that moves a class out
   * of `open` without going through those three — which is exactly what this
   * test is here to keep harmless.
   */
  it('does not reconcile a class that is no longer open', async () => {
    const cls = await makeClass(2);
    const waiter = await makeStudent('ClosedClass');

    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiter, position: 1, status: 'waiting' },
    });
    await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { cancelledAt: new Date() },
    });

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).autoPromote,
      streaks: createReconciliationStreaks(),
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
   * **The production CLOCK**, which no other test in this file exercises: every
   * window resolved from the real `new Date()` rather than an injected instant,
   * as the scheduler's tick reaches the sweep.
   *
   * Thread `opts.now ?? new Date(0)` through the module and every other test
   * stays green while production resolves every class to `auto_promote` and the
   * broadcast branch never runs again. Only a test that passes no clock at all
   * can catch that.
   *
   * It passes `opts` all the same, because `streaks` is required — and the
   * tracker below is this test's own rather than the module-level one
   * `runWaitlistReconciliationTick` holds. Calling that wrapper here would look
   * closer to production and behave worse: its tracker outlives the test, so
   * this test would inherit whatever streak ran before it and leave its own
   * behind for whatever runs next. `now` is the thing that must stay absent,
   * and it is the only thing this test keeps absent.
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

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date,
        startTime: hhmmToTime(startTime),
        // ONE MINUTE (#327): `nextSlot` spaces fixtures a minute apart, and
        // the slot constraint is a range overlap now — so a 60-minute fixture
        // collides with the one before it. Nothing here reads the duration;
        // the cancel-deadline window these tests turn on is computed from the
        // START.
        durationMinutes: 1,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 2,
        status: 'open',
        cancelDeadline: 'HOURS_24',
        settingsLocked: true,
      });
    classIds.push(cls.id);

    // Precondition, asserted rather than assumed — and it caught the offset
    // being wrong the first time. With a 24h deadline the claim window is
    // `[start − 25h, start − 24h)`, so `now` must sit inside it: the class
    // starts 24.5h out, not 25.5h, which is half an hour the wrong side of the
    // opening edge. Resolved with no `now`, like the sweep.
    expect(getWaitlistWindow(date, hhmmToTime(startTime), 'HOURS_24', TZ)).toBe('first_come_first_claimed');

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

    // One tracker across both calls, so the second tick sees what the first
    // left — the same continuity production has, without production's reach.
    const streaks = createReconciliationStreaks();

    const first = await reconcileWaitlists(prisma, { streaks });
    expect(first.repairedClassIds).toContain(cls.id);
    expect(await spotNotifications(cls.id, waiter)).toBe(1);

    const second = await reconcileWaitlists(prisma, { streaks });
    expect(second.reconciledClassIds).not.toContain(cls.id);
    expect(await spotNotifications(cls.id, waiter)).toBe(1);
  });

  /**
   * Past the cancel deadline the queue is frozen and no promotion may happen —
   * the sweep must not become a way around that. `handleSpotFreed` would return
   * `{ action: 'frozen' }` anyway, so this pins the sweep's OWN filter: without
   * it the hook is invoked and `reconciled` counts a class that was never
   * reconcilable.
   */
  it('does not reconcile a class whose window has frozen', async () => {
    const cls = await makeFreedSeat('Frozen');

    const summary = await reconcileWaitlists(prisma, {
      now: windowClocks(cls.startTime).frozen,
      streaks: createReconciliationStreaks(),
    });

    expect(summary.reconciledClassIds).not.toContain(cls.id);
    // The reason, so that a class skipped as `full` — or skipped by a gate that
    // has jammed shut — cannot pass as a working frozen filter.
    expect(summary.skipped).toContainEqual({ classId: cls.id, reason: 'frozen' });
    const promoted = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: cls.id, studentId: cls.waiter } },
    });
    expect(promoted).toBeNull();
  });

  /**
   * The classification: `isTransientDbError` decides a log level and a
   * message, and — via `ClassOutcome`'s `transient` field — whether the class
   * lands in `summary.transientFailedClassIds`. Inverting it, or hard-coding
   * either side, fails a log assertion and a summary assertion together.
   *
   * That mattered more than a normal logging gap. The module argues at length
   * that the split is the difference between a permanently broken promotion
   * path being visible and invisible — a defect that cannot clear on retry
   * fires again every sixty seconds forever, and at `warn` nobody would ever
   * look. Two tests, one per side, are what make that argument checkable.
   *
   * A healthy second class is created in each so the sweep still reconciles
   * something; otherwise every invoked class fails and the sweep throws
   * `ReconciliationFailedError`, which is its own test below.
   */
  it('logs a non-transient per-class failure at error level', async () => {
    const broken = await makeFreedSeat('NonTransient');
    const healthy = await makeFreedSeat('NonTransientOk');
    const clocks = windowClocks(broken.startTime);

    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    // Registered before anything can throw, so a failing assertion below still
    // hands `log.error` back to the tests that run after this one.
    onTestFinished(() => error.mockRestore());

    // `handleSpotFreed`'s own first statement is `class.findUnique`, so this
    // fails the hook for one class and leaves every other query untouched.
    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique({ args, query }) {
            if (args.where?.id === broken.id) throw new Error('schema drift');
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `reconcileWaitlists`' `PrismaClient`-typed parameter even though every
      // method it calls here is the real one — same cast as the
      // `email-fallback.test.ts` precedent.
    }) as unknown as PrismaClient;

    const summary = await reconcileWaitlists(faulty, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(summary.failedClassIds).toContain(broken.id);
    expect(summary.reconciledClassIds).toContain(healthy.id);
    const logged = error.mock.calls.find(
      (c) => (c[0] as { classId?: string } | undefined)?.classId === broken.id,
    );
    expect(logged).toBeDefined();
    expect(logged?.[0]).toMatchObject({ classId: broken.id, transient: false });
    // The classification now leaves the function that computed it. Before this it
    // picked a log level and was discarded, so nothing downstream could tell a
    // lost race from a defect that will never clear.
    expect(summary.transientFailedClassIds).not.toContain(broken.id);
  });

  it('logs a transient per-class failure at warn level', async () => {
    const contended = await makeFreedSeat('Transient');
    const healthy = await makeFreedSeat('TransientOk');
    const clocks = windowClocks(contended.startTime);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // `P2024` is a connection-pool timeout, which `api-errors.ts` classifies
    // transient — a real code from the set the catch block reasons about,
    // rather than a hand-rolled error shaped to pass.
    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique({ args, query }) {
            if (args.where?.id === contended.id) {
              throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
                code: 'P2024',
                clientVersion: Prisma.prismaVersion.client,
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const summary = await reconcileWaitlists(faulty, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    });

    expect(summary.failedClassIds).toContain(contended.id);
    expect(summary.reconciledClassIds).toContain(healthy.id);
    const logged = warn.mock.calls.find(
      (c) => (c[0] as { classId?: string } | undefined)?.classId === contended.id,
    );
    expect(logged).toBeDefined();
    expect(logged?.[0]).toMatchObject({ classId: contended.id, transient: true });
    expect(summary.transientFailedClassIds).toContain(contended.id);
    // A subset of `failedClassIds`, not a replacement for it — the same
    // relationship `repairedClassIds` has to `reconciledClassIds`.
    expect(summary.failedClassIds).toContain(contended.id);
  });

  /**
   * A tick that invoked classes and failed every one must THROW, not return
   * quietly.
   *
   * Returning is what let `scheduler.ts` stamp `lastSuccessAt` and null
   * `lastError` on a sweep that repaired nothing, so `/api/health` answered
   * `healthy: true` with a fresh timestamp — an affirmative false statement.
   * Per-class isolation is still intact; it is the all-failed case that
   * escalates.
   *
   * The fault is injected for EVERY class rather than a named one, which is
   * what makes this robust on a shared database: whatever leftover candidates
   * a killed run left behind, they fail too, so the all-failed condition holds
   * without the test having to own every row.
   */
  it('throws when every class it invoked failed', async () => {
    const cls = await makeFreedSeat('AllFail');
    const clocks = windowClocks(cls.startTime);

    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());

    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique() {
            throw new Error('every class fails');
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      reconcileWaitlists(faulty, {
      now: clocks.inClaimWindow,
      streaks: createReconciliationStreaks(),
    }),
    ).rejects.toThrow(ReconciliationFailedError);
  });

  /**
   * The production entry point runs the sweep and, unlike every other caller in
   * this file, carries memory between ticks. Asserting it delegates at all is
   * what stops the wiring in `scheduler.ts` from pointing at a function that
   * quietly forgets.
   */
  it('runs the sweep through the production entry point', async () => {
    const summary = await runWaitlistReconciliationTick(prisma);
    expect(summary.candidates).toBeGreaterThanOrEqual(0);
  });

  /**
   * A tick that lost every class to contention must NOT report the job
   * degraded — and after five of them in a row, it must.
   *
   * The sweep INVOKES a class only in the rare state it exists for — a free
   * seat and a live queue at the same moment — and skips every other
   * candidate, so one invoked class per tick is the ordinary case however many
   * teachers share the deployment. "Every class it tried failed" is therefore
   * reachable from one benign lock race that the next tick repairs. Throwing
   * on that trains an operator to ignore
   * `/api/health`. But never throwing reproduces #354 here: a leaked `idle in
   * transaction` session holding a Class row makes every tick fail forever while
   * the job reports success.
   */
  it('tolerates consecutive all-transient ticks, then reports the job degraded', async () => {
    const contended = await makeFreedSeat('StreakContended');
    const clocks = windowClocks(contended.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });

    // Injected for EVERY class, so whatever leftover candidates another run left
    // behind fail too and the all-failed condition holds without this test
    // owning every row — the same reasoning as `throws when every class it
    // invoked failed`.
    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique() {
            throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
              code: 'P2024',
              clientVersion: Prisma.prismaVersion.client,
            });
          },
        },
      },
    }) as unknown as PrismaClient;

    for (let tick = 1; tick < 5; tick += 1) {
      const summary = await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
      expect(summary.failedClassIds).toContain(contended.id);
      expect(streaks.allTransientTicks).toBe(tick);
    }

    await expect(
      reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks }),
    ).rejects.toMatchObject({ name: 'ReconciliationFailedError', reason: 'contended' });
  });

  /**
   * The streak is about UNBROKEN contention. A tick that reconciled something
   * proves the sweep is working, so the count starts again — otherwise five
   * scattered lock races over an hour would report a wedged sweep.
   */
  it('resets the contention streak on a tick that reconciled a class', async () => {
    const contended = await makeFreedSeat('StreakReset');
    const clocks = windowClocks(contended.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique() {
            throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
              code: 'P2024',
              clientVersion: Prisma.prismaVersion.client,
            });
          },
        },
      },
    }) as unknown as PrismaClient;

    await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
    expect(streaks.allTransientTicks).toBe(1);

    await reconcileWaitlists(prisma, { now: clocks.inClaimWindow, streaks });
    expect(streaks.allTransientTicks).toBe(0);
  });

  /**
   * Spec §4.4 rule 1: a tick that finds NO candidates at all — not one that
   * found candidates and skipped or failed them — must reset the streak too.
   * A wedged row lock keeps its class a candidate on every tick, so an empty
   * candidate set can only mean the queue drained or the class completed:
   * nothing is stuck, so there is nothing to keep the streak frozen for.
   *
   * `waitlistEntry.groupBy` is overridden rather than relying on the shared
   * database genuinely holding no waiting entries anywhere — this suite runs
   * alongside others against `ethical_yoga_test`, so the only deterministic
   * way to reach `reconcileWaitlists`'s first early return is to make the
   * candidate query itself report none, the same `$extends` mechanism the
   * fault-injection tests above use for the opposite purpose.
   */
  it('resets the streak on a tick with no candidates at all', async () => {
    const contended = await makeFreedSeat('StreakNoCandidates');
    const clocks = windowClocks(contended.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique() {
            throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
              code: 'P2024',
              clientVersion: Prisma.prismaVersion.client,
            });
          },
        },
      },
    }) as unknown as PrismaClient;

    await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
    expect(streaks.allTransientTicks).toBeGreaterThan(0);
    expect(streaks.failuresByClass.size).toBeGreaterThan(0);

    const noCandidates = prisma.$extends({
      query: {
        waitlistEntry: {
          groupBy() {
            return Promise.resolve([]);
          },
        },
      },
    }) as unknown as PrismaClient;

    const summary = await reconcileWaitlists(noCandidates, { now: clocks.inClaimWindow, streaks });
    expect(summary.candidates).toBe(0);
    expect(streaks.allTransientTicks).toBe(0);
    expect(streaks.failuresByClass.size).toBe(0);
  });

  /**
   * The SECOND no-candidate early return, which the test above cannot reach.
   *
   * `reconcileWaitlists` asks twice: `waitlistEntry.groupBy` for classes
   * holding a `waiting` entry, then `class.findMany` to re-read liveness,
   * because a class can complete or be cancelled between the two. Waiting
   * entries that resolve to no open, non-cancelled class land in the second
   * early return, and it resets the streak for the same reason as the first —
   * a wedged row lock keeps its class a candidate through BOTH queries, so
   * neither empty set is what a wedged lock looks like.
   *
   * Deleting that second `resetStreaks` call left the whole suite green:
   * everything above reaches the first return or none at all. This overrides
   * `class.findMany` rather than `waitlistEntry.groupBy`, which is exactly what
   * separates the two paths — the first tick below proves the candidate query
   * still answers with this class, so the tick under test can only be arriving
   * by the second door.
   */
  it('resets the streak when no candidate resolves to an open class', async () => {
    const contended = await makeFreedSeat('StreakNoOpenClass');
    const clocks = windowClocks(contended.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(log, 'debug').mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
      debug.mockRestore();
    });

    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique() {
            throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
              code: 'P2024',
              clientVersion: Prisma.prismaVersion.client,
            });
          },
        },
      },
    }) as unknown as PrismaClient;

    const contendedTick = await reconcileWaitlists(faulty, {
      now: clocks.inClaimWindow,
      streaks,
    });
    // This class WAS a candidate, so the candidate query answers with it — the
    // premise the tick below depends on for reaching the second early return
    // rather than the first.
    expect(contendedTick.failedClassIds).toContain(contended.id);
    expect(streaks.allTransientTicks).toBeGreaterThan(0);
    expect(streaks.failuresByClass.size).toBeGreaterThan(0);

    const noOpenClass = prisma.$extends({
      query: {
        class: {
          findMany() {
            return Promise.resolve([]);
          },
        },
      },
    }) as unknown as PrismaClient;

    const summary = await reconcileWaitlists(noOpenClass, { now: clocks.inClaimWindow, streaks });
    expect(summary.candidates).toBe(0);
    // The line only this path writes, and the one that tells the two returns
    // apart: the first reports no waiting entries at all.
    expect(debug.mock.calls.at(-1)?.[1]).toBe(
      'waitlist reconciliation found no open candidate class',
    );
    expect(streaks.allTransientTicks).toBe(0);
    expect(streaks.failuresByClass.size).toBe(0);
  });

  /**
   * A failure that will never clear by retrying escalates on the FIRST tick.
   * Routing it through the streak would hide a permanently broken promotion path
   * for five minutes, which is the defect this module exists to remove.
   */
  it('reports the job degraded immediately for a non-transient all-failed tick', async () => {
    const cls = await makeFreedSeat('ImmediateFail');
    const clocks = windowClocks(cls.startTime);
    const streaks = createReconciliationStreaks();

    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());

    const faulty = prisma.$extends({
      query: { class: { findUnique() { throw new Error('schema drift'); } } },
    }) as unknown as PrismaClient;

    await expect(
      reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks }),
    ).rejects.toMatchObject({ name: 'ReconciliationFailedError', reason: 'non_transient' });
  });

  /**
   * TWO failing classes in one tick, one transient and one not — the only
   * shape that can see `isContendedTick`'s third condition.
   *
   * That condition asks whether EVERY failure was transient. Weakening it to
   * "at least one was" left this whole suite green: every other all-failed test
   * here has a single failing class (where "every failure" and "some failure"
   * are the same question), or pairs a failing class with a healthy reconciling
   * one, which `decideEscalation` answers on its `allFailed` clause before
   * transience is ever consulted. So a tick carrying a genuine defect ALONGSIDE
   * a lock race would have been swallowed for the whole tolerance, which is the
   * defect the tolerance was added to avoid causing.
   *
   * The streak is fresh, so nothing here is repetition: a mixed tick escalates
   * on the tick it happens.
   */
  it('escalates at once when one class failed transiently and another did not', async () => {
    const wedged = await makeFreedSeat('MixedWedged');
    const contended = await makeFreedSeat('MixedContended');
    const clocks = windowClocks(wedged.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });

    // Routed by id for the transient half, and the DEFAULT arm fails too — the
    // sweep is database-wide, so a leftover candidate reconciling would make
    // this tick not all-failed. Same reasoning as `throws when every class it
    // invoked failed`, except the default arm here carries the non-transient
    // half of the mix rather than the whole tick.
    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique({ args }) {
            if (args.where?.id === contended.id) {
              throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
                code: 'P2024',
                clientVersion: Prisma.prismaVersion.client,
              });
            }
            throw new Error('schema drift');
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks }),
    ).rejects.toMatchObject({
      name: 'ReconciliationFailedError',
      reason: 'non_transient',
      // Both classes really were in this tick. Without this the assertion above
      // would also pass for a tick that only ever saw one of them, which is the
      // state every other test in this file is already in.
      failedClassIds: expect.arrayContaining([wedged.id, contended.id]),
    });

    // And the mix was genuine rather than assumed: the per-class lines show one
    // failure classified each way.
    const byClass = (calls: Array<[unknown, ...unknown[]]>, id: string) =>
      calls.map((c) => c[0] as { classId?: string; transient?: boolean })
        .filter((p) => p?.classId === id);
    expect(byClass(warn.mock.calls, contended.id).at(-1)).toMatchObject({ transient: true });
    expect(byClass(error.mock.calls, wedged.id).at(-1)).toMatchObject({ transient: false });
    // Escalated from a streak that never moved, not from repetition.
    expect(streaks.allTransientTicks).toBe(0);
  });

  /**
   * **Issue #269's acceptance criterion, at the real mechanism.** Everything
   * above injects a fault; this holds an actual `Class` row past
   * `lockClassRow`'s 2 s bound so the failure is a genuine `55P03` from
   * Postgres, with ONE candidate so the tick is all-failed.
   *
   * Follows `reconciles the remaining classes when one loses its lock race`,
   * which uses the same holder shape with two candidates.
   *
   * A hazard this test respects: the sweep is database-wide, so another class
   * left behind by an earlier test may reconcile in the same tick and make this
   * one not all-failed. The assertions are deliberately about `contended.id`
   * alone rather than about the tick throwing, which keeps them true either
   * way. Do not strengthen them to `expect(...).resolves` on the tick.
   */
  it('does not report degraded when its only class loses a real lock race', async () => {
    const contended = await makeFreedSeat('RealLockSolo');
    const clocks = windowClocks(contended.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((r) => { signalHeld = r; });
    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${contended.id} FOR UPDATE`;
        signalHeld();
        // Past lockClassRow's 2s bound, under Prisma's 5s default budget, so the
        // failure is 55P03 from Postgres rather than P2028 from the client.
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await lockHeld;

    const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow, streaks });

    await holder;
    await holderClient.$disconnect();

    expect(summary.failedClassIds).toContain(contended.id);
    expect(summary.transientFailedClassIds).toContain(contended.id);
  }, 60_000);

  /**
   * A class stuck behind a healthy sibling.
   *
   * The tick-level escalation cannot see this one: it requires that NO class
   * reconciled, so a single wedged class hides completely as soon as anything
   * else works. That was inherited rather than decided. The decision is an
   * `error` line naming the class and its streak, without holding an
   * otherwise-working job at `degraded` indefinitely. What that line buys
   * today is a record in the server log and nothing more — `lib/log.ts` is
   * pino to stdout with no transport, so nothing pages anyone off either level
   * (#157); the level is the correct classification for when that is fixed.
   */
  it('escalates a class contended for too many consecutive ticks, without reddening the job', async () => {
    const stuck = await makeFreedSeat('PerClassStuck');
    const healthy = await makeFreedSeat('PerClassHealthy');
    const clocks = windowClocks(stuck.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => {
      warn.mockRestore();
      error.mockRestore();
    });

    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique({ args, query }) {
            if (args.where?.id === stuck.id) {
              throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
                code: 'P2024',
                clientVersion: Prisma.prismaVersion.client,
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const forClass = (
      calls: Array<[unknown, ...unknown[]]>,
    ): Array<{ classId?: string; classStreak?: number }> =>
      calls
        .map((c) => c[0] as { classId?: string; classStreak?: number })
        .filter((p) => p?.classId === stuck.id);

    for (let tick = 1; tick < 5; tick += 1) {
      await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
      expect(forClass(warn.mock.calls).at(-1)).toMatchObject({ classStreak: tick });
      expect(forClass(error.mock.calls)).toHaveLength(0);
    }

    // The fifth consecutive failure crosses the threshold. `healthy`
    // reconciled on the first of these five ticks and its broadcast still
    // stands — a genuinely free seat is a one-shot event, so a healthy class
    // does not re-invoke every tick, it invokes once and then correctly gates
    // itself (`already_broadcast`). What matters for "without reddening the
    // job" is that this call resolves rather than throwing
    // `ReconciliationFailedError`: `decideEscalation` never crosses the
    // tick-level `allTransientTicks` threshold across this sequence, because
    // tick 1's success reset it and only four ticks remain.
    const summary = await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
    expect(summary.skipped).toContainEqual({ classId: healthy.id, reason: 'already_broadcast' });
    expect(streaks.allTransientTicks).toBeLessThan(5);
    expect(forClass(error.mock.calls).at(-1)).toMatchObject({ classStreak: 5 });
  });

  /**
   * The map is rebuilt from each tick's failures, so a class that recovers does
   * not carry its old count into a later failure.
   */
  it('drops a class from the streak map once it stops failing', async () => {
    const flaky = await makeFreedSeat('PerClassFlaky');
    const clocks = windowClocks(flaky.startTime);
    const streaks = createReconciliationStreaks();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const faulty = prisma.$extends({
      query: {
        class: {
          findUnique({ args, query }) {
            if (args.where?.id === flaky.id) {
              throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
                code: 'P2024',
                clientVersion: Prisma.prismaVersion.client,
              });
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
    expect(streaks.failuresByClass.get(flaky.id)).toBe(1);

    await reconcileWaitlists(prisma, { now: clocks.inClaimWindow, streaks });
    expect(streaks.failuresByClass.has(flaky.id)).toBe(false);
  });
});
