import { describe, it, expect, afterAll, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import * as dbLocks from '@/lib/db-locks';
import * as waitlist from '@/services/waitlist';
import { deleteStudentAccount } from '@/services/gdpr';
import { hhmmToTime } from '@/lib/time-of-day';
import { cookie, seedSession } from '../../../../tests/helpers';
import { createClassFixture } from '../../../../tests/class-fixtures';
import { POST } from './route';

/**
 * @serial-tier lock-contention — the tests below stage this route against
 * `deleteStudentAccount`, or against its `Student` lock, on real Postgres row
 * locks, and assert on how each meeting resolves: whether a racer waited,
 * whether the booking got a 409 or a 503 (a `55P03`), and which rows
 * survive. Lock noise from a neighbour in the
 * parallel tier would stretch a staged wait past the 2s `lock_timeout` these
 * outcomes turn on.
 *
 * `POST` is invoked directly, as `route.test.ts` does, and the erasure runs in
 * this process too, so a spy can pause either one at an exact statement. What
 * each test stages, and what it expects with and without the gate, is tabled
 * in `docs/superpowers/specs/2026-09-16-booking-erasure-gate-design.md`
 * (Tests).
 */
const prisma = new PrismaClient();

/**
 * How long a racer may take to start waiting on a lock. Well inside the 2s
 * `lock_timeout` the waiter runs under, and inside the Prisma budget of the
 * paused transaction it waits on.
 */
const WAIT_MS = 1_500;

/** How long a pause or holder may take to report that it is in place. */
const HANDSHAKE_MS = 2_000;

/**
 * How long the busy-database test holds the student's row: well past the
 * booking's 2s `lock_timeout`, so a gated booking times out first.
 */
const BUSY_HOLD_MS = 6_000;

const DELETED_MESSAGE = 'This account has been deleted';
const GONE_MESSAGE = "This student's account no longer exists";

type Settled = { status: number; message: string | null };
type ErasureOutcome = 'erased' | { error: string };
type Tracked<T> = { racer: Promise<T>; settled: () => boolean };

function book(token: string, body: { classId: string; studentId?: string }): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    }),
  );
}

/** A booking as a value: status and error message, never a rejection. */
function settle(response: Promise<Response>): Promise<Settled> {
  return response.then(
    async (res) => {
      const json: unknown = await res.json().catch(() => null);
      const error =
        typeof json === 'object' && json !== null && 'error' in json ? json.error : null;
      const message =
        typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : null;
      return { status: res.status, message };
    },
    (err: unknown) => ({ status: -1, message: String(err) }),
  );
}

function settleErasure(erasure: Promise<void>): Promise<ErasureOutcome> {
  return erasure.then(
    () => 'erased' as const,
    (err: unknown) => ({ error: String(err) }),
  );
}

/** Tracks whether a racer has settled, so a poll can stop early. */
function track<T>(racer: Promise<T>): Tracked<T> {
  let done = false;
  void racer.then(() => { done = true; });
  return { racer, settled: () => done };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/**
 * The pid of a backend waiting on a lock `holderPid` holds, or `null` if none
 * appears within `WAIT_MS` or before `stop()` turns true. A value, not a
 * throw: a racer that never waits is an outcome the test asserts on after the
 * end state.
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

async function handshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never happened within ${HANDSHAKE_MS}ms`)),
          HANDSHAKE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

/**
 * One teacher and two open 2099 classes.
 * `lockSetClassId`: five seats, the subject waiting at 1, so it is in the
 * erasure's class lock set.
 * `outsideClassId`: one seat, empty, another student waiting at 1; the
 * subject holds nothing in it, so it is outside that set.
 * The subject has an account, a fresh session and a null `tierSelectedAt`;
 * its entry is seeded directly, so no roster link or invitation exists.
 */
async function makeFixture() {
  const suffix = `reg-gate-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Gate',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Booking-gate fixture',
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
  const makeClass = async (date: string, maxStudents: number) =>
    (
      await createClassFixture(prisma, {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: 'Gate class',
        date: new Date(date),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents,
        status: 'open',
      })
    ).id;
  const lockSetClassId = await makeClass('2099-06-01', 5);
  const outsideClassId = await makeClass('2099-06-02', 1);

  const studentEmail = `${suffix}-subject@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Gate',
      lastName: 'Subject',
      email: studentEmail,
      claimedAt: new Date(),
      account: { create: { email: studentEmail } },
      incomeTier: 2,
    },
    select: { id: true, accountId: true },
  });
  const studentAccountId = student.accountId;
  if (studentAccountId === null) throw new Error('fixture student has no account');
  const waiter = await prisma.student.create({
    data: { firstName: 'Gate', lastName: 'Waiter', email: `${suffix}-waiter@test.local`, incomeTier: 2 },
    select: { id: true },
  });
  await prisma.waitlistEntry.create({
    data: { classId: lockSetClassId, studentId: student.id, position: 1, status: 'waiting' },
  });
  await prisma.waitlistEntry.create({
    data: { classId: outsideClassId, studentId: waiter.id, position: 1, status: 'waiting' },
  });

  return {
    teacherId: teacher.id,
    teacherAccountId: teacher.accountId,
    teacherToken: await seedSession(prisma, teacher.accountId),
    roomId: room.id,
    lockSetClassId,
    outsideClassId,
    studentId: student.id,
    studentAccountId,
    studentToken: await seedSession(prisma, studentAccountId),
    waiterId: waiter.id,
  };
}

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function cleanup(fx: Fixture): Promise<void> {
  const students = [fx.studentId, fx.waiterId];
  const accounts = [fx.teacherAccountId, fx.studentAccountId];
  await prisma.notification.deleteMany({ where: { recipientId: { in: [...students, fx.teacherId] } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fx.teacherId } });
  await prisma.room.deleteMany({ where: { id: fx.roomId } });
  await prisma.session.deleteMany({ where: { accountId: { in: accounts } } });
  await prisma.student.deleteMany({ where: { id: { in: students } } });
  await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: accounts } } });
}

/** A paused racer: reached once it holds, released by the test. */
type Pause = { reached: Promise<void>; pid: () => number; release: () => void };

/**
 * Pauses the erasure of `studentId` right after its `Student` lock is
 * granted, before its class pre-lock.
 */
function pauseErasureAtGate(studentId: string): Pause {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = dbLocks.lockStudentForErasure;
  const spy = vi.spyOn(dbLocks, 'lockStudentForErasure').mockImplementation(async (tx, id) => {
    await original(tx, id);
    if (id === studentId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

/**
 * Pauses the erasure after its registration cancel and its privacy, roster
 * and waitlist deletes, before its closing `Student` update: at the renumber
 * of `classId`, a class the subject waits in.
 */
function pauseErasureAfterWrites(classId: string): Pause {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = waitlist.reorderWaitingEntries;
  const spy = vi.spyOn(waitlist, 'reorderWaitingEntries').mockImplementation(async (tx, id) => {
    if (id === classId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
    return original(tx, id);
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

/**
 * Pauses the booking just before it locks `classId`: with the gate, it then
 * holds its student's row and nothing else.
 */
function pauseBookingBeforeClassLock(classId: string): Pause {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = dbLocks.lockClassRow;
  const spy = vi.spyOn(dbLocks, 'lockClassRow').mockImplementation(async (tx, id) => {
    if (id === classId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
    return original(tx, id);
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

async function registeredCount(studentId: string): Promise<number> {
  return prisma.registration.count({ where: { studentId, status: 'registered' } });
}

describe('POST /api/registrations takes the Student gate (#625)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Shape shared by every staged test below: an OUTER try/finally that always
  // reaps the fixture, and an INNER finally that releases every pause and
  // holder BEFORE joining the racers — the booking's post-commit marker write
  // waits on a held student row with no lock timeout. Racers are values, so
  // the join never throws.

  it('refuses a booking that waits behind the erasure, in a class the erasure locks', async () => {
    const fx = await makeFixture();
    try {
      const erasure = pauseErasureAtGate(fx.studentId);
      const erasing = settleErasure(deleteStudentAccount(prisma, fx.studentId));
      let booking: Tracked<Settled> | undefined;
      let bookingWaited = false;
      try {
        await handshake(erasure.reached, 'erasure Student lock');
        // The subject waits in this class, so the erasure's pre-lock will
        // request it. A booking that took the class before the student would
        // hold it while waiting on the erasure: `40P01`.
        booking = track(settle(book(fx.studentToken, { classId: fx.lockSetClassId })));
        bookingWaited = (await waiterOf(erasure.pid(), booking.settled)) !== null;
      } finally {
        erasure.release();
        await Promise.all([erasing, booking?.racer]);
      }

      expect(await erasing).toBe('erased');
      expect(await booking?.racer).toEqual({ status: 409, message: DELETED_MESSAGE });
      expect(await registeredCount(fx.studentId)).toBe(0);
      expect(await prisma.teacherStudent.count({ where: { studentId: fx.studentId } })).toBe(0);
      expect(bookingWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('refuses a booking that arrives after the erasure cancelled registrations', async () => {
    const fx = await makeFixture();
    try {
      const erasure = pauseErasureAfterWrites(fx.lockSetClassId);
      const erasing = settleErasure(deleteStudentAccount(prisma, fx.studentId));
      let booking: Tracked<Settled> | undefined;
      let bookingWaited = false;
      try {
        await handshake(erasure.reached, 'erasure renumber');
        booking = track(settle(book(fx.studentToken, { classId: fx.outsideClassId })));
        bookingWaited = (await waiterOf(erasure.pid(), booking.settled)) !== null;
      } finally {
        erasure.release();
        await Promise.all([erasing, booking?.racer]);
      }

      expect(await erasing).toBe('erased');
      expect(await booking?.racer).toEqual({ status: 409, message: DELETED_MESSAGE });
      expect(await registeredCount(fx.studentId)).toBe(0);
      expect(await prisma.teacherStudent.count({ where: { studentId: fx.studentId } })).toBe(0);
      expect(bookingWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('refuses a booking whose roster link the erasure has already deleted', async () => {
    const fx = await makeFixture();
    try {
      // The erasure deletes this row before the booking arrives; an ungated
      // booking's link insert would wait on that delete while holding its
      // registration's `FOR KEY SHARE` on the student.
      await prisma.teacherStudent.create({ data: { teacherId: fx.teacherId, studentId: fx.studentId } });
      const erasure = pauseErasureAfterWrites(fx.lockSetClassId);
      const erasing = settleErasure(deleteStudentAccount(prisma, fx.studentId));
      let booking: Tracked<Settled> | undefined;
      let bookingWaited = false;
      try {
        await handshake(erasure.reached, 'erasure renumber');
        booking = track(settle(book(fx.studentToken, { classId: fx.outsideClassId })));
        bookingWaited = (await waiterOf(erasure.pid(), booking.settled)) !== null;
      } finally {
        erasure.release();
        await Promise.all([erasing, booking?.racer]);
      }

      expect(await erasing).toBe('erased');
      expect(await booking?.racer).toEqual({ status: 409, message: DELETED_MESSAGE });
      expect(await registeredCount(fx.studentId)).toBe(0);
      expect(await prisma.teacherStudent.count({ where: { studentId: fx.studentId } })).toBe(0);
      expect(bookingWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('refuses a teacher adding the student after the erasure cancelled registrations', async () => {
    const fx = await makeFixture();
    try {
      // The roster check reads this row outside the transaction, where the
      // erasure's uncommitted delete of it is not yet visible.
      await prisma.teacherStudent.create({ data: { teacherId: fx.teacherId, studentId: fx.studentId } });
      const erasure = pauseErasureAfterWrites(fx.lockSetClassId);
      const erasing = settleErasure(deleteStudentAccount(prisma, fx.studentId));
      let booking: Tracked<Settled> | undefined;
      let bookingWaited = false;
      try {
        await handshake(erasure.reached, 'erasure renumber');
        booking = track(
          settle(book(fx.teacherToken, { classId: fx.outsideClassId, studentId: fx.studentId })),
        );
        bookingWaited = (await waiterOf(erasure.pid(), booking.settled)) !== null;
      } finally {
        erasure.release();
        await Promise.all([erasing, booking?.racer]);
      }

      expect(await erasing).toBe('erased');
      expect(await booking?.racer).toEqual({ status: 409, message: GONE_MESSAGE });
      expect(await registeredCount(fx.studentId)).toBe(0);
      expect(bookingWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('makes an erasure that arrives mid-booking wait, then cancel the booking and pass the seat on', async () => {
    const fx = await makeFixture();
    try {
      const bookingPause = pauseBookingBeforeClassLock(fx.outsideClassId);

      // Read on another connection when the erasure's pre-lock starts: the
      // `upcoming` read after it sees the booking only if this does.
      let bookedBeforePreLock: boolean | undefined;
      const originalPreLock = dbLocks.lockClassRowsOrdered;
      const preLockSpy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
        if (source.join === dbLocks.CLASS_TO_WAITLIST_JOIN && bookedBeforePreLock === undefined) {
          const reg = await prisma.registration.findUnique({
            where: { classId_studentId: { classId: fx.outsideClassId, studentId: fx.studentId } },
            select: { status: true },
          });
          bookedBeforePreLock = reg?.status === 'registered';
        }
        return originalPreLock(tx, source);
      });
      onTestFinished(() => preLockSpy.mockRestore());

      const booking = track(settle(book(fx.studentToken, { classId: fx.outsideClassId })));
      let erasing: Tracked<ErasureOutcome> | undefined;
      let erasureWaited = false;
      try {
        await handshake(bookingPause.reached, 'booking class lock');
        erasing = track(settleErasure(deleteStudentAccount(prisma, fx.studentId)));
        erasureWaited = (await waiterOf(bookingPause.pid(), erasing.settled)) !== null;
      } finally {
        bookingPause.release();
        await Promise.all([booking.racer, erasing?.racer]);
      }

      expect(await booking.racer).toMatchObject({ status: 201 });
      expect(await erasing?.racer).toBe('erased');
      const subject = await prisma.registration.findUnique({
        where: { classId_studentId: { classId: fx.outsideClassId, studentId: fx.studentId } },
        select: { status: true },
      });
      expect(subject?.status).toBe('cancelled');
      // `handleSpotFreed` ran for a class outside the erasure's lock set.
      const waiterReg = await prisma.registration.findUnique({
        where: { classId_studentId: { classId: fx.outsideClassId, studentId: fx.waiterId } },
        select: { status: true },
      });
      expect(waiterReg?.status).toBe('registered');
      expect(bookedBeforePreLock).toBe(true);
      expect(erasureWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('refuses a teacher adding an erased student whose roster link survived', async () => {
    const fx = await makeFixture();
    try {
      await deleteStudentAccount(prisma, fx.studentId);
      // A link that outlived the erasure: what an ungated link writer, or a
      // booking that survived an erasure, leaves behind.
      await prisma.teacherStudent.create({ data: { teacherId: fx.teacherId, studentId: fx.studentId } });

      const res = await settle(
        book(fx.teacherToken, { classId: fx.outsideClassId, studentId: fx.studentId }),
      );

      expect(res).toEqual({ status: 409, message: GONE_MESSAGE });
      expect(await prisma.registration.count({ where: { studentId: fx.studentId } })).toBe(0);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);

  it('answers a booking that times out behind an erasure lock as busy, not as deleted', async () => {
    const fx = await makeFixture();
    try {
      const parked = latch();
      const held = latch();
      let holderPid = 0;
      const holder = prisma
        .$transaction(
          async (tx) => {
            holderPid = await ownPid(tx);
            await dbLocks.lockStudentForErasure(tx, fx.studentId);
            parked.open();
            await held.promise;
          },
          { timeout: 30_000 },
        )
        .then(
          () => 'held' as const,
          (err: unknown) => ({ error: String(err) }),
        );

      let booking: Tracked<Settled> | undefined;
      let bookingWaited = false;
      try {
        await handshake(parked.promise, 'Student FOR NO KEY UPDATE holder');
        booking = track(settle(book(fx.studentToken, { classId: fx.outsideClassId })));
        bookingWaited = (await waiterOf(holderPid, booking.settled)) !== null;
        // Held until the booking settles, or well past its 2s wait at the latest.
        await Promise.race([booking.racer, new Promise((r) => setTimeout(r, BUSY_HOLD_MS))]);
      } finally {
        held.open();
        await Promise.all([holder, booking?.racer]);
      }

      const res = await booking?.racer;
      expect(res?.status).toBe(503);
      expect(res?.message).not.toBe(DELETED_MESSAGE);
      expect(await holder).toBe('held');
      expect(await prisma.registration.count({ where: { studentId: fx.studentId } })).toBe(0);
      expect(bookingWaited).toBe(true);
    } finally {
      await cleanup(fx);
    }
  }, 30_000);
});
