# Booking Erasure Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/registrations` takes `lockLiveStudent` for the booked student as the first statement of its transaction, on both the student and the teacher paths, so a booking can no longer survive a concurrent erasure of its student (#625).

**Architecture:**
- **The fix.** One call in the route, ahead of `lockClassRow`, plus a typed 409 in the route's existing `catch`.
- **The race tests.** A new serial-tier unit file. It calls the route's `POST` handler and `deleteStudentAccount` in the same process, pauses either one with `vi.spyOn`, and lets Postgres row locks decide what happens.
- **The docs.** A second task moves the booking route from "ungated" to "gated" in `docs/lock-order.md` and `docs/data-model.md`.

**Tech Stack:** Next.js 16 route handler, Prisma on PostgreSQL, Vitest 4 (`unit-sweeps` project for the new file, `integration` for the marker test).

**Spec:** `docs/superpowers/specs/2026-09-16-booking-erasure-gate-design.md`. Read it first. Its "Tests" section gives, for each case, the staging, the green outcome, and what the unchanged route does. Its "Clocks" and "Fixture constraints" subsections explain the constants and fixture choices below.

## Global Constraints

- TypeScript `strict`, no `any`.
- **Student-path refusal:** status 409, message `This account has been deleted`.
- **Teacher-path refusal:** status 409, message `This student's account no longer exists`.
- **Error bodies** have the shape `{ error: { message, code } }` (`respondError`, `src/lib/api-utils.ts`).
- **Comments** describe the code they sit on. Anything wider goes in `docs/`, and the comment links to it. No counts or member rosters in comments (CLAUDE.md, *Comment Discipline*).
- **Staging:** stage exact paths. Never run `git add -A` or `git add .`.
- **Dev server:** never restart the dev server on `:3000`. This worktree's app is already running on its own port. `--project integration` reads `INTEGRATION_BASE_URL` from `.env` automatically.
- **Shell:** this session refuses compound shell (loops, subshells, `$(...)`, variables) around git and docker. Run plain single commands.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Task order is load-bearing

Task 2 documents test names, test paths and the call-site census that Task 1 creates. Run Task 1 first.

---

### Task 1: Gate the booking route and prove it

**Files:**
- Modify: `src/app/api/registrations/route.ts`: the import at line 21, the transaction opening at lines 104-107, the marker comment at lines 278-282, and the `catch` at lines 306-333.
- Create: `src/app/api/registrations/route-lock-order.test.ts`
- Modify: `vitest.tiers.ts`: add the new file to `LOCK_CONTENTION_TESTS`.
- Modify: `tests/integration/registrations-api.test.ts`: the test "a first self-booking does not wait on a lock held on its student's row", specifically its docblock (about lines 719-735) and its holder (line 760).

**Interfaces:**
- **Consumes, from `@/lib/db-locks`** (all exist):
  - `lockLiveStudent(tx: TransactionClientOnly, studentId: string): Promise<void>`
  - `lockStudentForErasure(tx: TransactionClientOnly, studentId: string): Promise<void>`
  - `lockClassRow(tx: TransactionClientOnly, classId: string): Promise<void>`
  - `lockClassRowsOrdered`
  - `CLASS_TO_WAITLIST_JOIN`
  - `class StudentErasedError extends Error { readonly studentId: string }`
- **Consumes, from elsewhere:**
  - `deleteStudentAccount(db: PrismaClient, studentId: string): Promise<void>` from `@/services/gdpr`.
  - `reorderWaitingEntries(db: Prisma.TransactionClient, classId: string): Promise<void>` from `@/services/waitlist`.
  - `POST` from `./route`, invoked with a `NextRequest`, as `src/app/api/registrations/route.test.ts` does.
- **Produces, for Task 2 to cite:**
  - The file `src/app/api/registrations/route-lock-order.test.ts`. Its describe is `POST /api/registrations takes the Student gate (#625)`, and its seven test names are in Step 1.
  - Exactly one new call to `lockLiveStudent(` in `route.ts`.

- [ ] **Step 1: Write the race tests**

Create `src/app/api/registrations/route-lock-order.test.ts` with exactly this content:

```ts
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
 * @serial-tier lock-contention — every test below races this route against a
 * paused `deleteStudentAccount` on real Postgres row locks and asserts on how
 * the race resolves: whether a racer waited, whether the booking got a 409 or
 * a 503 (a `55P03`), and which rows survive. Lock noise from a neighbour in
 * the parallel tier would stretch a staged wait past the 2s `lock_timeout`
 * these outcomes turn on.
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
```

Check one mechanism when the file first runs. If it fails, report it to the controller rather than bending the test: `vi.spyOn(waitlist, 'reorderWaitingEntries')` and `vi.spyOn(dbLocks, 'lockClassRow')` must intercept named imports in other modules.
- `gdpr.ts` imports `reorderWaitingEntries` from `./waitlist`, and `route.ts` imports `lockClassRow` from `@/lib/db-locks`.
- `src/services/gdpr-lock-order.test.ts` relies on the same mechanism.
- If a pause never reports, the handshake names it.

- [ ] **Step 2: Put the file in the serial tier**

In `vitest.tiers.ts`, append to `LOCK_CONTENTION_TESTS`, after the `#183` entry:

```ts
  // #625: races the booking route against a paused erasure, the
  // `gdpr-lock-order.test.ts` shape; its header carries the reason.
  'src/app/api/registrations/route-lock-order.test.ts',
```

Run: `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts`

Expected: PASS. It checks that the marker and the list agree.

- [ ] **Step 3: Run the new file against the unchanged route and record the failures**

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/registrations/route-lock-order.test.ts`

Expected: every test fails. Record each test's first failing assertion in the task report. The spec's last column predicts:

| Test | Predicted failure |
|---|---|
| "…waits behind the erasure…" | 201, not 409 |
| "…arrives after the erasure cancelled registrations" | 201, and a `registered` row survives (the defect, reproduced) |
| "…roster link the erasure has already deleted" | a 503 carrying a `40P01` on the booking's side (visible in the logged error), or an erasure error naming `40P01` |
| "…teacher adding the student after…" | 201, and a `registered` row survives |
| "…erasure that arrives mid-booking…" | the subject's registration is `registered`, not `cancelled` |
| "…erased student whose roster link survived" | 201 |
| "…busy, not as deleted" | 201 after the hold |

A failure that differs from its prediction is a finding. Report its text, and do not adjust the test to match the prediction.

- [ ] **Step 4: Add the gate and the refusal to the route**

In `src/app/api/registrations/route.ts`, replace the import at line 21:

```ts
import { lockClassRow } from '@/lib/db-locks';
```

with:

```ts
import { lockClassRow, lockLiveStudent, StudentErasedError } from '@/lib/db-locks';
```

Replace the transaction opening (lines 104-107):

```ts
    const registration = await prisma.$transaction(async (tx) => {
      // Serialize concurrent registrations for this class: without the row
      // lock, two simultaneous requests both count below max and both insert.
      await lockClassRow(tx, body.classId);
```

with:

```ts
    const registration = await prisma.$transaction(async (tx) => {
      // The booked student's row first, before the class row, on both paths.
      // A booking and an erasure of this student serialise here, and a
      // booking that waited reads the erasure's committed `deletedAt` and
      // refuses before writing anything. Modes and order: `docs/lock-order.md`,
      // "The `Student` row is the erasure's gate".
      await lockLiveStudent(tx, studentId);

      // Serialize concurrent registrations for this class: without the row
      // lock, two simultaneous requests both count below max and both insert.
      await lockClassRow(tx, body.classId);
```

In the `catch`, directly after the `ClassNotFoundError` branch and before the `NotYourClassError` branch, add:

```ts
    if (err instanceof StudentErasedError) {
      return respondError(
        isTeacher ? "This student's account no longer exists" : 'This account has been deleted',
        409,
      );
    }
```

- [ ] **Step 5: State today's reason for the marker write's placement**

In the same file, in the comment above the `if (!rosterStudentId)` marker write, replace:

```ts
    // Written after the transaction commits, as a statement of its own:
    // a `Student` update is a lock on the `Student` row, so it must not come
    // after this transaction's other row locks. Scoped to a live profile
    // because an erasure can commit while this write waits on the row. Both
    // rules: `docs/lock-order.md`, "The `Student` row is the erasure's gate".
```

with:

```ts
    // Written after the transaction commits, as a statement of its own. The
    // transaction holds this student's row `FOR SHARE` from its first
    // statement, and an update inside it would upgrade that lock, which
    // deadlocks against another gated writer holding the same share on the
    // same student. Scoped to a live profile because an erasure can commit
    // while this write waits on the row. Both rules: `docs/lock-order.md`,
    // "The `Student` row is the erasure's gate".
```

Leave the rest of that comment ("A failure is logged…") unchanged.

- [ ] **Step 6: Move the marker test's holder to the gate's mode**

In `tests/integration/registrations-api.test.ts`, find the test "a first self-booking does not wait on a lock held on its student's row".

In its holder, replace:

```ts
        await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${student.id} FOR NO KEY UPDATE`;
```

with:

```ts
        await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${student.id} FOR SHARE`;
```

Replace its docblock (the `/** #183. A student erasure holds … */` block directly above the `it(`) with:

```ts
  /**
   * #183, #625. The booking takes its student's row `FOR SHARE` as its first
   * statement and holds it to commit, so a `Student` write inside its
   * transaction would upgrade that lock, and two gated writers of one student
   * upgrading at once deadlock (`docs/lock-order.md`, "The `Student` row is
   * the erasure's gate").
   *
   * The holder below takes `FOR SHARE`, the gate's own mode, standing in for a
   * second gated writer: the booking's gate shares it, and only an update of
   * the row waits on it. What this pins is that the booking's transaction
   * commits without waiting on it. The registration row is read on a separate
   * connection, so it appears only once that transaction has committed —
   * polled while the lock is still held. The marker write that follows the
   * commit does wait for the release, and then applies; the last two
   * assertions say so.
   *
   * A dedicated student, so no other test has stamped the marker, which is
   * first-choice-only; the `toBeNull` below checks that.
   */
```

Change nothing else in that test.

- [ ] **Step 7: Run everything that touches the route**

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/registrations/route-lock-order.test.ts`

Expected: PASS, all seven tests. Run it twice more to catch timing flakes, and report any flake with its text.

Run: `pnpm exec vitest run --project unit src/app/api/registrations/route.test.ts src/lib/serial-tier-membership.test.ts`

Expected: PASS.

Run: `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`

Expected: PASS. It runs against this worktree's app, which hot-reloads the route.

Run: `pnpm run typecheck`, then `pnpm run lint`.

Expected: both clean.

- [ ] **Step 8: Commit**

Commit now, before any mutation, so that restoring a mutation cannot discard other edits.

```bash
git add src/app/api/registrations/route.ts src/app/api/registrations/route-lock-order.test.ts vitest.tiers.ts tests/integration/registrations-api.test.ts
git commit -m "fix(registrations): take the Student gate before the class row (#625)"
```

Give the commit a body of one paragraph on what the gate closes, and end it with the Co-Authored-By line.

- [ ] **Step 9: Record the mutations**

For each mutation:

1. Apply it.
2. Run the named tests. Use `--project unit-sweeps` for the new file, and `--project integration` for M5. Before M5's run, warm the route: `curl -s -o /dev/null -X POST <INTEGRATION_BASE_URL from .env>/api/registrations`.
3. Record the exact first failing assertion for each named test. For M3, also record the SQLSTATE from the error the route logs (`transient database contention surfaced to a client`).
4. Restore the file with `git checkout -- <file>`, and confirm `git diff` is empty.

After the last restore, run the new file once more and confirm it is green.

| # | Mutation (in `route.ts`) | Must fail |
|---|---|---|
| M1 | `await lockLiveStudent(tx, studentId);` becomes `if (isTeacher) await lockLiveStudent(tx, studentId);` | "…waits behind the erasure…", "…arrives after…", "…roster link the erasure has already deleted", "…erasure that arrives mid-booking…", "…busy, not as deleted" |
| M2 | …becomes `if (!isTeacher) await lockLiveStudent(tx, studentId);` | "…teacher adding the student after…", "…erased student whose roster link survived" |
| M3 | move the gate call (with its comment) to directly after `await lockClassRow(tx, body.classId);` | "…waits behind the erasure, in a class the erasure locks", "…erasure that arrives mid-booking…" |
| M4 | wrap the gate: `await lockLiveStudent(tx, studentId).catch(() => { throw new StudentErasedError(studentId); });` | "…busy, not as deleted" |
| M5 | move the marker write into the transaction, directly before `return reg;`, as `if (!rosterStudentId) await tx.student.updateMany({ where: { id: studentId, tierSelectedAt: null, deletedAt: null }, data: { tierSelectedAt: new Date() } });`, and delete the post-commit block | `registrations-api.test.ts` "a first self-booking does not wait on a lock held on its student's row" |

If a mutation does not turn a named test red, stop and report it. That is a finding about the test, not a reason to strengthen the mutation.

---

### Task 2: Document the booking as a gated site

**Files:**
- Modify: `docs/lock-order.md`
  - section "The `Student` row is the erasure's gate (#183)", about lines 1110-1317
  - under "Known conformance": the `deleteStudentAccount` entry (about lines 2373-2384) and the `POST /api/registrations` entry (about lines 2497-2501)
- Modify: `docs/data-model.md`: section "Registration (student ↔ class)", after its table (about line 526)

**Interfaces:**
- Consumes:
  - Task 1's test file path and test names (Task 1, Step 1).
  - Task 1's Step 3 results (the failures on the unchanged route).
  - The route's refusal messages (Global Constraints).
  - The measurement in the spec's section "Why the marker write stays outside, now".
- Produces: nothing that code consumes.

Read the whole `Student` section before editing, and keep its voice: short declarative sentences, commands in indented blocks, a date on every census result.

- [ ] **Step 1: The site table**

Add a row after `addToWaitlist`'s:

```
| `POST /api/registrations` (`src/app/api/registrations/route.ts`) | `lockLiveStudent` | first statement of its transaction, on the student's booking and the teacher's roster add alike | `FOR SHARE` | refuses: 409, `This account has been deleted` to the student, `This student's account no longer exists` to the teacher |
```

- [ ] **Step 2: The order narrative**

"**`Student → Class` at both.**" becomes "**`Student → Class` at every site.**"

The three bullets below it ("The erasure first.", "The join first.", "A join after the erasure committed") are written about "the join". Restate them for "a gated writer" and keep each bullet's content. In "the writer first", add one clause for the booking: the erasure's `upcoming` read then sees the booking, so for an open class `handleSpotFreed` runs, even outside the lock set.

The paragraph "The order is observable only on a REJOIN…" stays about the join. After it, add a paragraph for the booking:

- The booking's order is observable when the booked class is in the erasure's lock set, that is, when the student holds an entry there.
- That case is pinned by `src/app/api/registrations/route-lock-order.test.ts`, test "refuses a booking that waits behind the erasure, in a class the erasure locks".
- The reverse race is pinned by "makes an erasure that arrives mid-booking wait, then cancel the booking and pass the seat on".
- The teacher path is pinned by "refuses a teacher adding an erased student whose roster link survived" and "refuses a teacher adding the student after the erasure cancelled registrations".

- [ ] **Step 3: The rule and the marker paragraph**

**The rule.** The rule paragraph starts "**An `UPDATE` or `DELETE` of a `Student` row is itself a lock on the `Student` node…**" and continues through "…must come before any other row lock in its transaction". After it, add the corollary for gated writers:

- A gated writer's own `FOR SHARE` on the row counts as such a lock.
- An update of the row inside a gated transaction is an upgrade.
- Two gated writers of one student each hold `FOR SHARE`, because the mode is compatible with itself, and if both upgrade they deadlock.
- Measured 2026-09-16: two sessions each took `FOR SHARE` on one `Student` row, then each updated it. The first failed with `40P01` "while updating tuple … in relation "Student"".

**The marker paragraph.** The paragraph beginning "`POST /api/registrations` writes `Student.tierSelectedAt` after its transaction commits because of this rule" keeps its history: the two cycles the in-transaction write closed while the booking was ungated.

- After that history, add: since #625 the booking is gated, so the corollary above is what keeps the write outside.
- Correct the pin sentence: the pinning test's holder now takes `FOR SHARE`, the gate's own mode. The booking's gate shares it, and only an update waits on it.

- [ ] **Step 4: "What still escalates" and "Who is not gated yet"**

**"What still escalates".**
- Delete the bullet "A booking holds the `FOR KEY SHARE` its `Registration` insert took while its roster-link insert can wait on the erasure. Tracked in #625."
- The sentence "The last two are reasoned from the code and have not been reproduced. All three predate the gate." becomes a statement about the two remaining cases: both are reasoned from the code, neither has been reproduced, and both predate the gate.
- Then add one sentence: the booking's case is closed by #625, and its cycle was reproduced against the ungated route by the test "refuses a booking whose roster link the erasure has already deleted". **Use Task 1's recorded Step 3 result here**, and quote the SQLSTATE it actually showed.

**"Who is not gated yet".**
- Delete the `POST /api/registrations` bullet.
- The intro "The inserters into tables with a foreign key to `Student`, other than `addToWaitlist`:" becomes "…other than `addToWaitlist` and `POST /api/registrations`:".
- Re-run the two re-derivation commands in that subsection. Correct the result paragraph below them ("On 2026-09-16 the first returned five statement sites …") only if the output differs.

- [ ] **Step 5: Re-derive the gate call-site census**

Run the command exactly as the doc gives it:

```bash
grep -rn 'lockStudentForErasure\|lockLiveStudent' src/ --include='*.ts' | grep -v '\.test\.ts:' | grep -vE ':[0-9]+: *(\*|//)' | grep -vE ':[0-9]+: +[A-Za-z]+,$'
```

Expected: six lines. The extra one is the route's single-line import, which the doc's filters do not drop.

**Extend the documented command.** Add one more filter as its last line:

```
      | grep -vE ':[0-9]+:import '
```

Run the extended command. Confirm it returns five lines: the two definitions in `db-locks.ts`, and one call each in `gdpr.ts`, `waitlist.ts` and `route.ts`.

**Show that the new filter drops only imports.** The six-line output above differs from the five-line one only by the route's import. Also confirm that none of the five lines starts with `import`.

**Update the doc's result sentence** to: "On 2026-09-16 it returned five lines: the two definitions in `db-locks.ts`, and one call each in `gdpr.ts`, `waitlist.ts` and `src/app/api/registrations/route.ts`. A new gated writer is a sixth."

**Update the filter explanation.** It currently reads "the last two filters drop comment prose and the members of multi-line `import { … }` blocks". Change it to cover the new filter as well, which drops single-line import statements.

- [ ] **Step 6: "Known conformance"**

**The `POST /api/registrations` entry.** It currently reads "`Class`, then `Registration`, `WaitlistEntry`, `TeacherStudent`, then `TeacherBlock`/`Invitation` via `resolveInvitationOnLink` …". Prepend `Student` in the same form as `addToWaitlist`'s entry: "`Student` (`lockLiveStudent`, #625), then `Class`, then …". Keep the rest.

**The `deleteStudentAccount` entry.** Replace "Its `registration.updateMany` also reaches classes outside the lock set, and a booking racing the erasure is #625." with text saying:

- Its `registration.updateMany` also reaches classes outside the lock set.
- A booking cannot race it there, because `POST /api/registrations` takes the other half of the `Student` gate (#625).
- A booking's registration is therefore either in the erasure's statement snapshots or refused.

Leave the rest of the paragraph and its "Status:" line as they are.

- [ ] **Step 7: `docs/data-model.md`**

After the `Registration` table, add:

```markdown
**A booking that races its own student's erasure is refused (#625).** The
erasure wins, as it does for a waitlist join: `POST /api/registrations` and
`deleteStudentAccount` serialise on the `Student` row, on the student's own
booking and on the teacher's roster add alike. A booking that finds the profile
erased writes nothing and answers 409 — `This account has been deleted` to the
student, `This student's account no longer exists` to the teacher. A booking
that takes the row first commits, and the erasure then cancels the
registration if its class is still open, and passes the freed seat on. It does
not undo the rest of the booking: `resolveInvitationOnLink` may have cleared a
`TeacherBlock` and resolved an `Invitation`, and the erasure recreates no block
and anonymises that invitation's identity without reverting its status. The
mechanism is `docs/lock-order.md`, "The `Student` row is the erasure's gate".
```

- [ ] **Step 8: Sweep for what this invalidated**

1. Run `git grep -n "#625" -- docs src tests vitest.tiers.ts`. Every hit must either describe the booking as gated, or belong to this branch's spec, plan or tests.
2. Run `git grep -n -i "ungated\|not gated" -- docs/lock-order.md docs/data-model.md src`, and read every hit that mentions bookings or `POST /api/registrations`.
3. Run `git grep -n "Class\`, then \`Registration" -- docs`, and confirm no other description of the route's lock order starts at `Class`.

Report every hit, each with a verdict.

- [ ] **Step 9: Commit**

```bash
git add docs/lock-order.md docs/data-model.md
git commit -m "docs(lock-order): the booking route takes the Student gate (#625)"
```

End the message with the Co-Authored-By line.
