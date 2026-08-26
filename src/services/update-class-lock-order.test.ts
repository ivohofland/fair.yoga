import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { completeClass, updateClass } from './class-lifecycle';

/**
 * `updateClass` must not slip a reschedule past a completion that is already
 * holding the class (#327, stage B spec §2.2).
 *
 * THE INTERLEAVING THIS PINS, in the spec's own words: `completeClass` locks
 * the row, reads the entry, computes the end instant and decides the class has
 * ended; `updateClass` moves the entry's `startTime`; `completeClass` then runs
 * the pricing engine and writes `Payment` rows. A class billed against a time
 * it no longer had — #182, restored by the extraction.
 *
 * It is restored by a lock COVERAGE gap, not a lock ORDER one. Before #327
 * `updateClass` took no lock and did not need one: the row it wrote was the row
 * `completeClass` had locked, so its plain `UPDATE` blocked for free. `date`,
 * `startTime` and `durationMinutes` then moved to `CalendarEntry`, and that
 * free lock started covering the wrong table.
 *
 * TWO CHANGES CLOSE IT, AND THIS CASE FAILS ONLY WHEN BOTH ARE ABSENT —
 * measured, and stated that way rather than as "it catches each of them",
 * which is what the first draft of this paragraph claimed. `lockClassRow`
 * taking the entry row as well as the class row, and `updateClass` calling it
 * rather than relying on Prisma's statement order. Either ONE of them alone
 * still parks the reschedule behind the completion — the wide helper because
 * the completion then holds the entry row the reschedule must write, the
 * explicit call because the reschedule then queues on the class row — so
 * reverting one leaves this green. See the mutation table on the `it` below.
 *
 * WHY NO `setTimeout` ANYWHERE. A sleep would pass locally and flake in CI, and
 * worse: under the fix the reschedule BLOCKS, so a sleep long enough to be
 * reliable can outlast `lockClassRow`'s own 2s `lock_timeout` and make the
 * assertion pass for a reason unrelated to the fix. Both handshakes here are
 * driven by observed state — a promise the completion resolves once it holds
 * its locks, and `pg_stat_activity` for the reschedule's backend actually
 * waiting on one.
 *
 * WHY THE REASON, NEVER THE BOOLEAN. A `55P03` lock timeout would also make
 * `ok` false. `reason: 'frozen'` is the only outcome that says the reschedule
 * waited, saw the completion, and refused on the entry's own freeze.
 */
const prisma = new PrismaClient();

/**
 * A client with exactly one connection, so `pg_backend_pid()` read from it once
 * identifies the backend every later statement runs on. That is what lets the
 * handshake below watch for THIS reschedule waiting on a lock rather than for
 * any backend anywhere — `pg_stat_activity` is database-wide, and the `unit`
 * project runs its files in parallel.
 */
function singleConnectionClient(): PrismaClient {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', '1');
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

describe('updateClass against a completion that already holds the class', () => {
  const suffix = `updcls-lock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const rescheduleDb = singleConnectionClient();
  const completionDb = new PrismaClient();
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let entryId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        bio: 'updateClass lock-order fixture',
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

    // Dated far in the future, and completed with `finishedEarly` rather than
    // `requireEndedBy`. The property under test is the reschedule's
    // SERIALISATION against a held completion, and `lockClassRow` is
    // `completeClass`'s first statement either way — so the timing branch adds
    // nothing here and a class near "now" would make the reschedule's own
    // past-start guard (#249) the thing that answered, depending on the hour
    // the suite runs.
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
            status: 'in_progress',
          },
        },
      },
      select: { id: true, classes: { select: { id: true } } },
    });
    entryId = entry.id;
    classId = entry.classes[0]!.id;
  });

  afterAll(async () => {
    await prisma.class.deleteMany({ where: { calendarEntryId: entryId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: `${suffix}@test.local` } });
    await Promise.all([
      prisma.$disconnect(),
      rescheduleDb.$disconnect(),
      completionDb.$disconnect(),
    ]);
  });

  /**
   * MUTATION TABLE, measured on 2026-08-26 by reverting each row and running
   * this file. Recorded in full including the two it does NOT catch, because
   * a mutation list that names only the detected ones over-claims:
   *
   * | reverted                                          | result |
   * |---|---|
   * | `lockClassRow` narrow AND `updateClass` lock-free | FAILS — `{ ok: true }`, `expected true to be false` |
   * | `lockClassRow` narrow only                        | passes — the reschedule queues on the `Class` row |
   * | `updateClass`'s `lockClassRow` call only          | passes — the reschedule queues on the entry row |
   *
   * The two "passes" rows are not a gap in this case; they are the shape of
   * the property. Either mechanism alone still serialises THIS pair, and the
   * defect is the state where neither does. What the wide helper buys beyond
   * that pair is coverage for `completeClass`'s own READ of the entry's three
   * scheduling columns, which no reschedule outcome can observe.
   */
  it('refuses a reschedule that races a completion, and says why', async () => {
    // The reschedule's backend, read before the race so the watcher below can
    // ask about that pid specifically.
    const [backend] = await rescheduleDb.$queryRaw<Array<{ pid: number }>>`
      SELECT pg_backend_pid()::int AS pid`;
    const reschedulePid = backend!.pid;

    let completionHasLocks!: () => void;
    const locksHeld = new Promise<void>((resolve) => {
      completionHasLocks = resolve;
    });
    let releaseCompletion!: () => void;
    const completionReleased = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });

    // Hooked on `class.findUnique`, which `completeClass` issues immediately
    // AFTER `lockClassRow` and before anything it decides from — so when this
    // fires, both row locks are held and nothing has been written.
    let hookFired = false;
    const hookedCompletionDb = completionDb.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            if (!hookFired) {
              hookFired = true;
              completionHasLocks();
              await completionReleased;
            }
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `completeClass`'s `PrismaClient`-typed parameter even though every
      // method it calls here is the real one against the real database — the
      // same cast `template-lock-order.test.ts` uses for its hooked clients.
    }) as unknown as PrismaClient;

    const completion = completeClass(hookedCompletionDb, classId, { finishedEarly: true });
    await locksHeld;

    let rescheduleSettled = false;
    const reschedule = updateClass(rescheduleDb, classId, {
      startTime: hhmmToTime('10:30'),
    }).then((value) => {
      rescheduleSettled = true;
      return value;
    });

    // Wait until the reschedule is either PARKED on a lock (the fixed
    // behaviour) or already finished without waiting for one (the defect).
    // Every iteration is a database round trip, not a timer, and the loop
    // cannot spin for ever: it exits on whichever of the two happens.
    while (!rescheduleSettled) {
      const [waiting] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE pid = ${reschedulePid} AND wait_event_type = 'Lock'`;
      if ((waiting?.n ?? 0) > 0) break;
    }

    releaseCompletion();

    const completionResult = await completion;
    const outcome = await reschedule;

    // The premise: the completion actually completed. Without this, a
    // completion that failed for its own reasons would leave the entry
    // unfrozen and the assertions below would be about nothing.
    expect(hookFired).toBe(true);
    expect(completionResult).toMatchObject({ ok: true, newStatus: 'completed' });

    expect(outcome.ok).toBe(false);
    // The REASON, never the boolean: a `55P03` lock timeout would also make
    // `ok` false, and so would `terminal` — which is the class row's refusal,
    // not the entry's, and would mean the reschedule had been answered by the
    // half of the freeze that never moved.
    expect(outcome).toMatchObject({ reason: 'frozen' });

    // And the entry kept its start. The refusal is only worth anything if the
    // write it refused did not land.
    const entry = await prisma.calendarEntry.findUniqueOrThrow({
      where: { id: entryId },
      select: { startTime: true, classCompletedAt: true },
    });
    expect(entry.startTime.toISOString()).toBe(hhmmToTime('09:00').toISOString());
    expect(entry.classCompletedAt).not.toBeNull();
  });
});
