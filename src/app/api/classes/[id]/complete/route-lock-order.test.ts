/**
 * @serial-tier lock-contention — each case parks this route's completion on a
 * `Class` row another transaction holds, under `lockClassRow`'s 2s
 * `lock_timeout`, and asserts that it waited. Lock noise from a tier-mate can
 * stretch that wait past the bound and turn the answer under test into a 503.
 *
 * `POST` is invoked directly, as `src/app/api/classes/route.test.ts` invokes
 * its own; the pause is the spy technique of
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, type Prisma } from '@prisma/client';
import * as dbLocks from '@/lib/db-locks';
import { hhmmToTime } from '@/lib/time-of-day';
import { completeClass } from '@/services/class-lifecycle';
import { cookie, seedSession, uniqueSuffix } from '../../../../../../tests/helpers';
import { createClassFixture } from '../../../../../../tests/class-fixtures';
import { expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';
import { POST } from './route';

const prisma = new PrismaClient();
const suffix = `complete-lock-${uniqueSuffix()}`;

/** How long a pause or holder may take to report that it is in place. */
const HANDSHAKE_MS = 2_000;

/** How long the route may take to start waiting: inside the 2s `lock_timeout` it waits under. */
const WAIT_MS = 1_500;

type Tracked<T> = { racer: Promise<T>; settled: () => boolean };

function complete(token: string, classId: string): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost:3000/api/classes/${classId}/complete`, {
      method: 'POST',
      headers: cookie(token),
    }),
    { params: Promise.resolve({ id: classId }) },
  );
}

function track<T>(racer: Promise<T>): Tracked<T> {
  let done = false;
  void racer.then(
    () => { done = true; },
    () => { done = true; },
  );
  return { racer, settled: () => done };
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

/**
 * Pauses the first `completeClass` to lock `classId` right after it holds the
 * class row, before it reads anything. Later callers lock normally, so they
 * wait on it.
 */
function pauseCompletionAtLock(classId: string): {
  reached: Promise<void>;
  pid: () => number;
  release: () => void;
} {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = dbLocks.lockClassRow;
  const spy = vi.spyOn(dbLocks, 'lockClassRow').mockImplementation(async (tx, id) => {
    await original(tx, id);
    if (id === classId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

describe('POST /api/classes/[id]/complete against a transaction holding the class', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let token: string;
  let day = 0;

  /** In progress, one day apart per call so no two fixtures share a slot. */
  const makeClass = () => {
    day += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Complete Race',
      date: new Date(Date.UTC(2099, 10, day)),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 30,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 4,
      status: 'in_progress',
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    const email = `${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Complete', lastName: 'Race', email, bio: 'complete race fixture',
        pageSlug: suffix, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Complete Race Room', address: `${suffix} Race St`, city: 'Testville',
        postcode: '1234CR', floor: '1', roomName: 'Race', maxCapacity: 10, createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;
    const student = await prisma.student.create({
      data: { firstName: 'Complete', lastName: 'Racer', email: `${suffix}-student@test.local`, incomeTier: 3 },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    // The entry cascades to its class, the class to its registrations, a
    // registration to its payment.
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /**
   * The double-click on Complete. Both requests pass the route's own read; the
   * second waits on the class row while the first completes it, then reads
   * `completed` under the lock. Only the service's answer can tell the route
   * that — its own read, taken before the wait, still says `in_progress`.
   */
  it('answers the second of two completions unchanged, decided under the lock, and bills once', async () => {
    const cls = await makeClass();
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
    });
    try {
      const pause = pauseCompletionAtLock(cls.id);
      const winning = completeClass(prisma, cls.id, { finishedEarly: true });
      let losing: Tracked<Response> | undefined;
      let waited = false;
      try {
        await handshake(pause.reached, 'the first completion taking the class lock');
        losing = track(complete(token, cls.id));
        waited = (await waiterOf(pause.pid(), losing.settled)) !== null;
      } finally {
        pause.release();
        await winning.catch(() => undefined);
        await losing?.racer.catch(() => undefined);
      }
      if (losing === undefined) throw new Error('the second completion never started');

      expect(await winning).toMatchObject({ ok: true, newStatus: 'completed' });
      expect(waited).toBe(true);
      expect(await expectUnchanged(await losing.racer)).toEqual({ ok: true, newStatus: 'completed' });
      expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(1);
      expect(
        await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'payment_request' } }),
      ).toBe(2);
    } finally {
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { id: cls.calendarEntryId } });
    }
  }, 15_000);

  /**
   * A template archive hard-deletes future live classes, so a class can vanish
   * between the route's read and the service's locked one. The answer is
   * `NOT_FOUND` at 404, decided from the locked read: the route's own read
   * found the class, and only the service can see that it since went.
   */
  it('answers NOT_FOUND when the class is deleted while the completion waits on it', async () => {
    const cls = await makeClass();
    const holderLocked = latch();
    const release = latch();
    let holderPid = 0;
    const holding = prisma.$transaction(
      async (tx) => {
        holderPid = await ownPid(tx);
        await tx.$executeRaw`DELETE FROM "Class" WHERE id = ${cls.id}`;
        holderLocked.open();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    try {
      let losing: Tracked<Response> | undefined;
      let waited = false;
      try {
        await handshake(holderLocked.promise, 'the holder deleting the class');
        losing = track(complete(token, cls.id));
        waited = (await waiterOf(holderPid, losing.settled)) !== null;
      } finally {
        release.open();
        await holding.catch(() => undefined);
        await losing?.racer.catch(() => undefined);
      }
      if (losing === undefined) throw new Error('the completion never started');

      await holding;
      expect(waited).toBe(true);
      await expectRefusal(await losing.racer, 'NOT_FOUND');
    } finally {
      // The holder deleted the class, which orphans the entry rather than
      // cascading to it; removed by its own id.
      await prisma.calendarEntry.deleteMany({ where: { id: cls.calendarEntryId } });
    }
  }, 15_000);
});
