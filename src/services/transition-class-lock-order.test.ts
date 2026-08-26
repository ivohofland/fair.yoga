import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { lockClassRow } from '@/lib/db-locks';
import { transitionClass } from './class-lifecycle';

/**
 * `transitionClass` must not walk a class forward past a cancel that is
 * already holding it (#327, PR review).
 *
 * WHY THIS BECAME POSSIBLE. On `main` the CAS was
 * `where: { id, status: { in: sourceStatesFor(target) } }` — single-table, and
 * race-free for free: every conjunct sat on the row the `UPDATE` itself locks,
 * so a writer that blocked on that row had its qual re-checked by
 * `EvalPlanQual` against the freshly committed tuple. #327 moved liveness to
 * `CalendarEntry.cancelledAt` and the CAS gained
 * `calendarEntry: { cancelledAt: null }`. `EvalPlanQual` re-fetches only the
 * LOCKED row; a subplan over a second table keeps the PRE-WAIT snapshot, where
 * `cancelledAt` is still NULL. So the transition blocked, unblocked, saw
 * nothing, and left the class live-and-cancelled.
 *
 * This is the mechanism `db-locks.ts` documents and the stage B spec §2.3
 * measures — and `transitionClass` was the one status writer still without the
 * lock, where the cancel route, `completeClass`, `updateClass` and both sweeps
 * all take it.
 *
 * THE HOLDER IS THE CANCEL ROUTE'S OWN TRANSACTION, hand-rolled because
 * `POST /api/classes/[id]/cancel` has no service function to call — its two
 * statements are `lockClassRow` and a `calendarEntry.updateMany` writing
 * `cancelledAt`, and both are reproduced below in that order.
 *
 * WHY NO `setTimeout`. Under the fix the transition BLOCKS, and a sleep long
 * enough to be reliable in CI can outlast `lockClassRow`'s own 2s
 * `lock_timeout` — which would make the assertion pass for a reason unrelated
 * to the fix. The handshake is driven by observed state instead: a promise the
 * holder resolves once it has written under its locks, and `pg_stat_activity`
 * for the transition's own backend actually waiting on one.
 *
 * WHY THE REASON, NEVER THE BOOLEAN. A `55P03` lock timeout would also make
 * `ok` false, and so would `CONCURRENT_MODIFICATION`. `reason: 'CANCELLED'` is
 * the only outcome that says the transition waited, re-read, and refused
 * because the class is off.
 */
const prisma = new PrismaClient();

/**
 * A client with exactly one connection, so `pg_backend_pid()` read from it once
 * identifies the backend every later statement runs on — the same device
 * `update-class-lock-order.test.ts` uses, and for the same reason:
 * `pg_stat_activity` is database-wide and the `unit` project runs its files in
 * parallel.
 */
function singleConnectionClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', '1');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

describe('transitionClass against a cancel that already holds the class', () => {
  const suffix = `trncls-lock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const transitionDb = singleConnectionClient();
  const cancelDb = new PrismaClient();
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let entryId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock',
        lastName: 'Transition',
        email: `${suffix}@test.local`,
        bio: 'transitionClass lock-order fixture',
        pageSlug: suffix,
        account: { create: { email: `${suffix}@test.local` } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Venue',
        address: 'Street 1',
        city: 'Town',
        postcode: '1234AB',
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

    // `open`, and dated far in the future. `open -> in_progress` is a legal
    // transition that reaches the CAS directly: the `targetStatus === 'open'`
    // pre-reads at the top of `transitionClass` are skipped entirely, so
    // nothing but the CAS decides this, which is what the case is about.
    const entry = await prisma.calendarEntry.create({
      data: {
        teacherId,
        kind: 'regular',
        classType: 'Lock order',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        classes: {
          create: {
            teacherRoomId: teacherRoom.id,
            roomCost: 20,
            minRate: 15,
            targetRate: 25,
            minStudents: 1,
            maxStudents: 10,
            status: 'open',
          },
        },
      },
      select: { id: true, classes: { select: { id: true } } },
    });
    entryId = entry.id;
    classId = entry.classes[0]!.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: `${suffix}@test.local` } });
    await Promise.all([
      prisma.$disconnect(),
      transitionDb.$disconnect(),
      cancelDb.$disconnect(),
    ]);
  });

  /**
   * MUTATION, measured on 2026-08-26 by putting `setLockTimeout(tx)` back in
   * place of `lockClassRow(tx, classId)` and running this file:
   *
   * | reverted                                | result |
   * |---|---|
   * | `lockClassRow` -> `setLockTimeout`      | FAILS — `{ ok: true, newStatus: 'in_progress' }` on a cancelled class |
   *
   * The transition waits in BOTH worlds — the CAS's own `UPDATE` queues on the
   * `Class` row the holder locked — so the handshake below cannot tell them
   * apart and does not try to. What tells them apart is the outcome, which is
   * the whole of the `EvalPlanQual` argument: re-fetching the locked row does
   * not re-fetch a subplan over a second table.
   */
  it('refuses a transition that races a cancel, and says why', async () => {
    const [backend] = await transitionDb.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::int AS pid`;
    const transitionPid = backend!.pid;

    let cancelHasWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      cancelHasWritten = resolve;
    });
    let releaseCancel!: () => void;
    const cancelReleased = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });

    // `POST /api/classes/[id]/cancel`'s two statements, in its order.
    const cancelling = cancelDb.$transaction(
      async (tx) => {
        await lockClassRow(tx, classId);
        const updated = await tx.calendarEntry.updateMany({
          where: {
            id: entryId,
            cancelledAt: null,
            classes: { some: { status: { in: ['draft', 'open'] } } },
          },
          data: { cancelledAt: new Date() },
        });
        cancelHasWritten();
        await cancelReleased;
        return updated.count;
      },
      { timeout: 20_000 },
    );

    await written;

    let transitionSettled = false;
    const transitioning = transitionClass(transitionDb, classId, 'in_progress').then(
      (value) => {
        transitionSettled = true;
        return value;
      },
    );

    // Wait until the transition is either PARKED on a lock or already finished
    // without waiting for one. Every iteration is a database round trip, not a
    // timer, and the loop exits on whichever of the two happens.
    while (!transitionSettled) {
      const [waiting] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE pid = ${transitionPid} AND wait_event_type = 'Lock'`;
      if ((waiting?.n ?? 0) > 0) break;
    }

    releaseCancel();

    const cancelledCount = await cancelling;
    const outcome = await transitioning;

    // The premise: the cancel actually cancelled. Without this, a cancel that
    // wrote nothing would leave the entry live and the assertion below would
    // be about nothing.
    expect(cancelledCount).toBe(1);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('CANCELLED');

    // And the row itself, because "the call refused" and "the status did not
    // move" are different claims. This one is the defect.
    const after = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { status: true },
    });
    expect(after.status).toBe('open');
  });
});
