import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';
import { addToWaitlist, handleSpotFreed } from './waitlist';
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
        email: `${suffix}-${label.toLowerCase()}-${studentIds.length}@test.local`,
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

  /**
   * Past the cancel deadline the queue is frozen and no promotion may happen —
   * the sweep must not become a way around that. `handleSpotFreed` would return
   * `{ action: 'frozen' }` anyway, so this pins the sweep's OWN filter: without
   * it the hook is invoked and `reconciled` counts a class that was never
   * reconcilable.
   *
   * Runs LAST on purpose: a frozen class is left with a free seat and a `waiting`
   * entry, so it is itself a reconcilable candidate. `reconcileWaitlists` sweeps
   * the whole database, not just this fixture's classes — an earlier test's
   * sweep would count this class and inflate its own `reconciled` figure.
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
});
