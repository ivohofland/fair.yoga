/**
 * @serial-tier lock-contention — each case holds a real `TeacherStudent` or
 * `Payment` row lock open while a second transaction queues behind it, and a
 * booking side runs under `lockClassRow`'s 2s `lock_timeout`. A neighbour's
 * lock noise stretching that wait would land a `55P03` on the booking, which
 * reads as the serialisation failing.
 *
 * What each ordering means, and which case pins it: `docs/lock-order.md`,
 * "The `TeacherStudent` row is the archive's gate".
 */
import { describe, it, expect, afterAll, onTestFinished, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { archiveStudent, type ArchiveOutcome } from './student-archive';
import { reopenPayment } from './payments';
import { activateRegistration } from './waitlist';
import * as rosterLink from './roster-link';
import { lockClassRow } from '@/lib/db-locks';
import { isLockTimeout } from '@/lib/api-errors';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import { joinOrThrow } from '../../tests/lock-order-teardown';

/** Client A holds; client B races; `prisma` also observes and seeds. */
const prisma = new PrismaClient();
const racer = new PrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
  await racer.$disconnect();
});

/**
 * How long a racer may take to start waiting on a lock: inside the 2s
 * `lock_timeout` a booking waits under, and inside every Prisma budget here.
 */
const WAIT_MS = 1_500;

/** How long a holder may take to report that it is in place. */
const HANDSHAKE_MS = 2_000;

/**
 * The Prisma budget of the transactions this file opens itself: `holdAfter`'s
 * holders and the archive-first booking. A hold lasts at most `WAIT_MS` past
 * the handshake, so such a holder always commits on its own release rather
 * than being aborted by Prisma, which would free the row for the wrong reason.
 *
 * It does not govern a holder paused by `pauseAtLink`: that one is the
 * service's own `$transaction` (`archiveStudent`, `reopenPayment`) on Prisma's
 * 5s default. Its worst case is `HANDSHAKE_MS + WAIT_MS` from that
 * transaction's start to its release — 3.5s, inside the 5s.
 */
const HOLD_BUDGET_MS = 10_000;

type Tracked<T> = { racer: Promise<T>; settled: () => boolean };
type Pause = { reached: Promise<void>; pid: () => number; release: () => void };

function track<T>(p: Promise<T>): Tracked<T> {
  let done = false;
  const tracked = p.finally(() => { done = true; });
  return { racer: tracked, settled: () => done };
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/**
 * The pid of a backend waiting on a lock `holderPid` holds, or `null` if none
 * appears within `WAIT_MS` or before `stop()` turns true. A value, not a
 * throw: a racer that never waits is an outcome each case asserts on.
 */
async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function handshake(signal: Promise<void>, label: string, holder: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} never happened within ${HANDSHAKE_MS}ms`)), HANDSHAKE_MS);
      }),
      holder.then((outcome) => {
        throw new Error(`${label} never happened: the holder settled first with ${JSON.stringify(outcome)}`);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Runs `body` in a transaction on client A, then holds it open — every lock
 * `body` took still held — until `release()`, and commits.
 */
function holdAfter(body: (tx: Prisma.TransactionClient) => Promise<void>): Pause & { done: Promise<void> } {
  const reached = latch();
  const held = latch();
  let pid = 0;
  const done = prisma.$transaction(
    async (tx) => {
      await body(tx);
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    },
    { timeout: HOLD_BUDGET_MS },
  );
  return { reached: reached.promise, pid: () => pid, release: held.open, done };
}

/**
 * Pauses the FIRST caller of `lockTeacherStudentLink` for this pair right
 * after the lock returns — `archiveStudent` before its counts, or
 * `reopenPayment` before its compare-and-swap — holding the link row with
 * nothing written. Later callers for the pair pass straight through to the
 * real lock, and so queue behind the paused one.
 */
function pauseAtLink(pair: { teacherId: string; studentId: string }): Pause {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = rosterLink.lockTeacherStudentLink;
  const spy = vi.spyOn(rosterLink, 'lockTeacherStudentLink').mockImplementation(async (tx, p) => {
    const row = await original(tx, p);
    if (!paused && p.teacherId === pair.teacherId && p.studentId === pair.studentId) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
    return row;
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

/** A booking's statements from its class lock on: the `POST /api/registrations` order. */
async function bookingTail(
  tx: Prisma.TransactionClient,
  input: { classId: string; teacherId: string; studentId: string },
): Promise<void> {
  const lock = await lockClassRow(tx, input.classId);
  await activateRegistration(tx, lock, { classId: input.classId, studentId: input.studentId, tierAtBooking: 3 });
  await rosterLink.linkTeacherStudent(tx, { teacherId: input.teacherId, studentId: input.studentId });
}

/** The code a refused archive carries; throws, naming the outcome, otherwise. */
function refusalCode(outcome: ArchiveOutcome | undefined): string {
  if (outcome?.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  return outcome.refusal.code;
}

/**
 * A teacher, a student already on their roster (active link), an open 2099
 * class with a seat, and a completed class the student attended.
 */
async function makeFixture() {
  const suffix = `archive-gate-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Gate',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Archive-gate fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Gate Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234GT',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const common = {
    teacherId: teacher.id,
    teacherRoomId: teacherRoom.id,
    classType: 'Gate class',
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 5,
  };
  const openClass = await createClassFixture(prisma, { ...common, date: new Date('2099-06-01'), status: 'open' });
  const completedClass = await createClassFixture(prisma, {
    ...common,
    date: new Date('2025-01-06'),
    status: 'completed',
    settingsLocked: true,
  });
  const student = await prisma.student.create({
    data: { firstName: 'Gate', lastName: 'Subject', email: `${suffix}-subject@test.local`, incomeTier: 3 },
    select: { id: true },
  });
  await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });
  const attended = await prisma.registration.create({
    data: {
      classId: completedClass.id,
      studentId: student.id,
      status: 'attended',
      tierAtBooking: 3,
      price: 12.1,
      tierRatio: 1.0,
    },
    select: { id: true },
  });
  return {
    teacherId: teacher.id,
    teacherAccountId: teacher.accountId,
    roomId: room.id,
    studentId: student.id,
    openClassId: openClass.id,
    attendedRegistrationId: attended.id,
  };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function cleanup(fx: Fixture): Promise<void> {
  // Registrations and payments cascade off the entries' classes.
  await prisma.calendarEntry.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.teacherStudent.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.room.deleteMany({ where: { id: fx.roomId } });
  await prisma.student.deleteMany({ where: { id: fx.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
  await prisma.account.deleteMany({ where: { id: fx.teacherAccountId } });
}

async function linkArchived(fx: Fixture): Promise<boolean> {
  const link = await prisma.teacherStudent.findUniqueOrThrow({
    where: { teacherId_studentId: { teacherId: fx.teacherId, studentId: fx.studentId } },
    select: { isArchived: true },
  });
  return link.isArchived;
}

async function liveRegistrations(fx: Fixture): Promise<number> {
  return prisma.registration.count({
    where: { classId: fx.openClassId, studentId: fx.studentId, status: 'registered' },
  });
}

async function paymentFor(fx: Fixture, status: 'pending' | 'not_charged'): Promise<string> {
  const payment = await prisma.payment.create({
    data: {
      registrationId: fx.attendedRegistrationId,
      amount: 12.1,
      status,
      ...(status === 'not_charged' ? { notChargedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return payment.id;
}

describe('the TeacherStudent row serialises archiving against what makes a pair live (#265)', () => {
  // Shape shared by every case: an OUTER try/finally that always reaps the
  // fixture, and an INNER finally that releases the holder BEFORE joining the
  // racers, so a failing assertion never leaves a transaction parked.

  it('booking first: the archive waits for the booking to commit, then refuses on its registration', async () => {
    const fx = await makeFixture();
    try {
      // The link already exists, so the booking's `INSERT … ON CONFLICT DO
      // NOTHING` takes no lock on it — only `activateTeacherStudentLink`'s
      // `FOR UPDATE` does.
      const booking = holdAfter((tx) => bookingTail(tx, { ...fx, classId: fx.openClassId }));
      let archive: Tracked<ArchiveOutcome> | undefined;
      let archiveWaited = false;
      let settledDuringHold = true;
      try {
        await handshake(booking.reached, 'booking link lock', booking.done);
        archive = track(archiveStudent(racer, { teacherId: fx.teacherId, studentId: fx.studentId }));
        archiveWaited = (await waiterOf(booking.pid(), archive.settled)) !== null;
        settledDuringHold = archive.settled();
      } finally {
        booking.release();
        await joinOrThrow(booking.done, archive?.racer);
      }

      expect(refusalCode(await archive?.racer)).toBe('STUDENT_HAS_UNBILLED_CLASSES');
      expect(await linkArchived(fx)).toBe(false);
      expect(await liveRegistrations(fx)).toBe(1);
      expect(archiveWaited).toBe(true);
      expect(settledDuringHold).toBe(false);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('archive first: the booking waits for the archive to commit, then clears the flag it set', async () => {
    const fx = await makeFixture();
    try {
      const archivePause = pauseAtLink(fx);
      const archiving = archiveStudent(prisma, { teacherId: fx.teacherId, studentId: fx.studentId });
      let booking: Tracked<void> | undefined;
      let bookingWaited = false;
      let settledDuringHold = true;
      try {
        await handshake(archivePause.reached, 'archive link lock', archiving);
        // The booking's registration insert lands while the archive holds the
        // link, uncommitted, so the archive's count cannot see it.
        booking = track(
          racer.$transaction((tx) => bookingTail(tx, { ...fx, classId: fx.openClassId }), {
            timeout: HOLD_BUDGET_MS,
          }),
        );
        bookingWaited = (await waiterOf(archivePause.pid(), booking.settled)) !== null;
        settledDuringHold = booking.settled();
      } finally {
        archivePause.release();
        await joinOrThrow(archiving, booking?.racer);
      }

      // The archive committed its flag before the booking could read the row…
      expect(await archiving).toEqual({ kind: 'archived', waivedCount: 0 });
      // …and the booking, once let through, cleared it.
      expect(await linkArchived(fx)).toBe(false);
      expect(await liveRegistrations(fx)).toBe(1);
      expect(bookingWaited).toBe(true);
      expect(settledDuringHold).toBe(false);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('reopen vs archive: the reopen waits for the archive to commit, then un-archives', async () => {
    const fx = await makeFixture();
    try {
      const paymentId = await paymentFor(fx, 'not_charged');
      const archivePause = pauseAtLink(fx);
      const archiving = archiveStudent(prisma, { teacherId: fx.teacherId, studentId: fx.studentId });
      let reopen: Tracked<Awaited<ReturnType<typeof reopenPayment>>> | undefined;
      let reopenWaited = false;
      let settledDuringHold = true;
      try {
        await handshake(archivePause.reached, 'archive link lock', archiving);
        reopen = track(reopenPayment(racer, paymentId));
        reopenWaited = (await waiterOf(archivePause.pid(), reopen.settled)) !== null;
        settledDuringHold = reopen.settled();
      } finally {
        archivePause.release();
        await joinOrThrow(archiving, reopen?.racer);
      }

      // A `not_charged` payment is not outstanding, so the archive went through…
      expect(await archiving).toEqual({ kind: 'archived', waivedCount: 0 });
      // …and the reopen, run after it, made the payment owed and the link active.
      expect((await reopen?.racer)?.kind).toBe('applied');
      expect(await linkArchived(fx)).toBe(false);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
      expect(payment.status).toBe('pending');
      expect(reopenWaited).toBe(true);
      expect(settledDuringHold).toBe(false);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('reopen first: the archive waits for the reopen to commit, then refuses on the payment it made owed', async () => {
    const fx = await makeFixture();
    try {
      const paymentId = await paymentFor(fx, 'not_charged');
      const reopenPause = pauseAtLink(fx);
      const reopening = reopenPayment(prisma, paymentId);
      let archive: Tracked<ArchiveOutcome> | undefined;
      let archiveWaited = false;
      let settledDuringHold = true;
      try {
        await handshake(reopenPause.reached, 'reopen link lock', reopening);
        // The reopen holds the link and has not yet made the payment owed,
        // so an archive that did not wait would read it `not_charged`.
        archive = track(archiveStudent(racer, { teacherId: fx.teacherId, studentId: fx.studentId }));
        archiveWaited = (await waiterOf(reopenPause.pid(), archive.settled)) !== null;
        settledDuringHold = archive.settled();
      } finally {
        reopenPause.release();
        await joinOrThrow(reopening, archive?.racer);
      }

      expect((await reopening).kind).toBe('applied');
      expect(refusalCode(await archive?.racer)).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
      expect(await linkArchived(fx)).toBe(false);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
      expect(payment.status).toBe('pending');
      expect(archiveWaited).toBe(true);
      expect(settledDuringHold).toBe(false);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('a payment settled between the archive reading it open and waiving it refuses the whole archive', async () => {
    const fx = await makeFixture();
    try {
      const paymentId = await paymentFor(fx, 'pending');
      // `markPaymentPaid`'s own statement, held uncommitted: it takes the
      // payment row and not the link, so the archive reads the payment open
      // and then queues on it at the waive.
      const marking = holdAfter(async (tx) => {
        const { count } = await tx.payment.updateMany({
          where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
          data: { status: 'paid', method: 'cash', paidAt: new Date() },
        });
        if (count !== 1) throw new Error(`mark-paid fixture wrote ${count} rows`);
      });
      let archive: Tracked<ArchiveOutcome> | undefined;
      let archiveWaited = false;
      let settledDuringHold = true;
      try {
        await handshake(marking.reached, 'mark-paid payment lock', marking.done);
        archive = track(
          archiveStudent(racer, { teacherId: fx.teacherId, studentId: fx.studentId, waivePaymentIds: [paymentId] }),
        );
        archiveWaited = (await waiterOf(marking.pid(), archive.settled)) !== null;
        settledDuringHold = archive.settled();
      } finally {
        marking.release();
        await joinOrThrow(marking.done, archive?.racer);
      }

      expect(refusalCode(await archive?.racer)).toBe('STUDENT_HAS_OUTSTANDING_PAYMENTS');
      expect(await linkArchived(fx)).toBe(false);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
      expect(payment.status).toBe('paid');
      expect(archiveWaited).toBe(true);
      expect(settledDuringHold).toBe(false);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  // The waive misses as in the case above, and the link is deleted after the
  // rollback releases it and before the re-read locks it again: the second
  // `lockTeacherStudentLink` call for the pair commits the delete first.
  it('a pair unlinked after a waive miss answers not-linked, not a refusal', async () => {
    const fx = await makeFixture();
    try {
      const paymentId = await paymentFor(fx, 'pending');
      let calls = 0;
      const original = rosterLink.lockTeacherStudentLink;
      const spy = vi.spyOn(rosterLink, 'lockTeacherStudentLink').mockImplementation(async (tx, p) => {
        if (p.teacherId === fx.teacherId && p.studentId === fx.studentId && ++calls === 2) {
          await prisma.teacherStudent.delete({
            where: { teacherId_studentId: { teacherId: fx.teacherId, studentId: fx.studentId } },
          });
        }
        return original(tx, p);
      });
      onTestFinished(() => spy.mockRestore());
      const marking = holdAfter(async (tx) => {
        const { count } = await tx.payment.updateMany({
          where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
          data: { status: 'paid', method: 'cash', paidAt: new Date() },
        });
        if (count !== 1) throw new Error(`mark-paid fixture wrote ${count} rows`);
      });
      let archive: Tracked<ArchiveOutcome> | undefined;
      let archiveWaited = false;
      try {
        await handshake(marking.reached, 'mark-paid payment lock', marking.done);
        archive = track(
          archiveStudent(racer, { teacherId: fx.teacherId, studentId: fx.studentId, waivePaymentIds: [paymentId] }),
        );
        archiveWaited = (await waiterOf(marking.pid(), archive.settled)) !== null;
      } finally {
        marking.release();
        await joinOrThrow(marking.done, archive?.racer);
      }

      expect({ outcome: await archive?.racer, archiveWaited, calls }).toEqual({
        outcome: { kind: 'not-linked' },
        archiveWaited: true,
        calls: 2,
      });
    } finally {
      await cleanup(fx);
    }
  }, 30_000);
});

/**
 * Each side opens its transaction with `setLockTimeout`, so a link row held
 * past the bound fails the call with `55P03` — which `withErrorHandler`
 * answers 503 — instead of waiting unbounded. The hold outlasts the 2s bound
 * and ends inside Prisma's 5s default, so the rejection is Postgres's, not
 * Prisma's transaction timeout.
 */
describe('archiving and reopening bound their wait on the link row (#265)', () => {
  const HOLD_MS = 3_500;

  async function rejectsWithinHold(fx: Fixture, run: () => Promise<unknown>): Promise<{ settledDuringHold: boolean; lockTimeout: boolean }> {
    const holding = holdAfter(async (tx) => {
      if ((await rosterLink.lockTeacherStudentLink(tx, fx)) === null) throw new Error('fixture link missing');
    });
    let call: Tracked<unknown> | undefined;
    let settledDuringHold = false;
    try {
      await handshake(holding.reached, 'link lock', holding.done);
      // Settled into a value at once, so the rejection has a handler while it waits.
      call = track(run().then(() => null, (e: unknown) => e));
      const deadline = Date.now() + HOLD_MS;
      while (Date.now() < deadline && !call.settled()) await new Promise((r) => setTimeout(r, 25));
      settledDuringHold = call.settled();
    } finally {
      holding.release();
      await holding.done;
    }
    const err: unknown = await call?.racer;
    return { settledDuringHold, lockTimeout: isLockTimeout(err) };
  }

  it('archiveStudent', async () => {
    const fx = await makeFixture();
    try {
      const result = await rejectsWithinHold(fx, () =>
        archiveStudent(racer, { teacherId: fx.teacherId, studentId: fx.studentId }));
      expect(result).toEqual({ settledDuringHold: true, lockTimeout: true });
      expect(await linkArchived(fx)).toBe(false);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('reopenPayment', async () => {
    const fx = await makeFixture();
    try {
      const paymentId = await paymentFor(fx, 'not_charged');
      const result = await rejectsWithinHold(fx, () => reopenPayment(racer, paymentId));
      expect(result).toEqual({ settledDuringHold: true, lockTimeout: true });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } });
      expect(payment.status).toBe('not_charged');
    } finally {
      await cleanup(fx);
    }
  }, 30_000);
});
