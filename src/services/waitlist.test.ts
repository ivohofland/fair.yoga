import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  getWaitlistWindow,
  addToWaitlist,
  removeFromWaitlist,
  promoteNext,
  claimSpot,
  handleSpotFreed,
  closeQueueOnStart,
  WaitlistJoinError,
  WaitlistPromotionError,
} from './waitlist';
import { hhmmToTime } from '@/lib/time-of-day';

// ===========================================================================
// Pure logic tests — getWaitlistWindow
// ===========================================================================

describe('getWaitlistWindow', () => {
  it('returns auto_promote when more than 1 hour before deadline', () => {
    // classDate: 2026-04-10, startTime: "09:00", deadline: HOURS_24
    // Class starts April 10 09:00 UTC
    // Deadline = April 9 09:00 UTC, cutoff = April 9 08:00 UTC
    // now = April 8 12:00 UTC → well before cutoff → 'auto_promote'
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'UTC',
      new Date('2026-04-08T12:00:00Z'),
    );
    expect(result).toBe('auto_promote');
  });

  it('returns first_come_first_claimed in final hour before deadline', () => {
    // Same setup: deadline = April 9 09:00 UTC, cutoff = April 9 08:00 UTC
    // now = April 9 08:30 UTC → between cutoff and deadline → 'first_come_first_claimed'
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'UTC',
      new Date('2026-04-09T08:30:00Z'),
    );
    expect(result).toBe('first_come_first_claimed');
  });

  it('returns frozen after deadline', () => {
    // Same setup: deadline = April 9 09:00 UTC
    // now = April 9 10:00 UTC → past deadline → 'frozen'
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'UTC',
      new Date('2026-04-09T10:00:00Z'),
    );
    expect(result).toBe('frozen');
  });

  it('handles 6h deadline correctly', () => {
    // classDate: 2026-04-10, startTime: "09:00", deadline: HOURS_6
    // Class starts April 10 09:00 UTC
    // Deadline = April 10 03:00 UTC, cutoff = April 10 02:00 UTC
    // now = April 10 02:30 UTC → between cutoff and deadline → 'first_come_first_claimed'
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_6',
      'UTC',
      new Date('2026-04-10T02:30:00Z'),
    );
    expect(result).toBe('first_come_first_claimed');
  });

  it('returns frozen exactly at deadline time', () => {
    // Deadline = April 9 09:00 UTC
    // now = exactly April 9 09:00 UTC → frozen (>= deadline)
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'UTC',
      new Date('2026-04-09T09:00:00Z'),
    );
    expect(result).toBe('frozen');
  });

  it('returns first_come_first_claimed exactly at cutoff time', () => {
    // Cutoff = April 9 08:00 UTC
    // now = exactly April 9 08:00 UTC → first_come_first_claimed (>= cutoff)
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'UTC',
      new Date('2026-04-09T08:00:00Z'),
    );
    expect(result).toBe('first_come_first_claimed');
  });

  it('handles HOURS_48 deadline', () => {
    // classDate: 2026-04-10, startTime: "09:00", deadline: HOURS_48
    // Deadline = April 8 09:00 UTC, cutoff = April 8 08:00 UTC
    // now = April 7 12:00 UTC → auto_promote
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_48',
      'UTC',
      new Date('2026-04-07T12:00:00Z'),
    );
    expect(result).toBe('auto_promote');
  });

  it('handles HOURS_12 deadline', () => {
    // classDate: 2026-04-10, startTime: "09:00", deadline: HOURS_12
    // Deadline = April 9 21:00 UTC, cutoff = April 9 20:00 UTC
    // now = April 9 20:30 UTC → first_come_first_claimed
    const result = getWaitlistWindow(
      new Date('2026-04-10'),
      hhmmToTime('09:00'),
      'HOURS_12',
      'UTC',
      new Date('2026-04-09T20:30:00Z'),
    );
    expect(result).toBe('first_come_first_claimed');
  });

  it('defaults to current time when now is not provided', () => {
    // Use a class far in the future to guarantee auto_promote
    const result = getWaitlistWindow(
      new Date('2099-12-31'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'UTC',
    );
    expect(result).toBe('auto_promote');
  });

  it('computes the window in the teacher timezone, not UTC', () => {
    // Amsterdam summer (+2): class 2026-07-20 09:00 local = 07:00 UTC.
    // HOURS_24 deadline = 2026-07-19 07:00 UTC.
    // now = 2026-07-19 08:00 UTC — past the local deadline (frozen),
    // but a UTC reading would still say first_come_first_claimed.
    const result = getWaitlistWindow(
      new Date('2026-07-20'),
      hhmmToTime('09:00'),
      'HOURS_24',
      'Europe/Amsterdam',
      new Date('2026-07-19T08:00:00Z'),
    );
    expect(result).toBe('frozen');
  });
});

// ===========================================================================
// Integration tests — addToWaitlist, removeFromWaitlist, promoteNext
// ===========================================================================

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once a block's fixture counter crosses 30 — a raw `HH:${counter}` literal
 * would build exactly that. `Class.startTime` is `@db.Time` and would refuse
 * the row outright at the DB, which is a less useful failure here than this
 * guard's message naming the fixture counter that produced it. The two
 * blocks below that use this each pick their own hour offset (`slotTime(60 +
 * counter)` for a `10:xx` base) so neither counter's values can land in the
 * other's hour. Mirrors `class-template-lifecycle.test.ts`'s `slotTime`.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

describe('addToWaitlist + removeFromWaitlist (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let notFullClassId: string;
  let draftClassId: string;
  const studentIds: string[] = [];
  const fillerIds: string[] = [];

  // Counter-derived startTime: this describe's `beforeAll` calls `makeClass`
  // 3 times, and the nested `closeQueueOnStart` describe below calls it more
  // — none of these tests read or assert a created row's literal startTime,
  // so a distinct minute per call is enough to keep every create legal under
  // Class_teacher_slot_unique. Routed through the module-level `slotTime`
  // rather than a raw `09:${counter}` literal. Hoisted to describe scope
  // (rather than declared inside `beforeAll`, as it originally was) so the
  // nested describe can call it too, after `teacherId`/`teacherRoomId` are
  // set.
  let makeClassCounter = 0;
  async function makeClass(
    status: 'open' | 'draft' | 'in_progress',
    maxStudents: number,
  ): Promise<string> {
    makeClassCounter += 1;
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime(slotTime(makeClassCounter)),
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents,
        status,
        settingsLocked: true,
      },
    });
    return cls.id;
  }

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Waitlist',
        lastName: 'Teacher',
        email: `waitlist-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `waitlist-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for waitlist tests',
        pageSlug: `waitlist-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Waitlist Studio',
        address: `${uniqueSuffix} Waitlist St`,
        city: 'Amsterdam',
        postcode: '1234WL',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId,
        capacityOverride: 15,
        rentalRate: 35,
      },
    });
    teacherRoomId = teacherRoom.id;

    // The waitlist class holds 2 and both spots are taken by fillers.
    classId = await makeClass('open', 2);
    notFullClassId = await makeClass('open', 12);
    draftClassId = await makeClass('draft', 2);

    for (let i = 1; i <= 2; i++) {
      const filler = await prisma.student.create({
        data: {
          firstName: `WaitlistFiller${i}`,
          lastName: 'Test',
          email: `waitlist-filler-${i}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
      });
      fillerIds.push(filler.id);
      await prisma.registration.create({
        data: { classId, studentId: filler.id, status: 'registered', tierAtBooking: 3 },
      });
    }

    // Create 3 students
    for (let i = 1; i <= 3; i++) {
      const student = await prisma.student.create({
        data: {
          firstName: `WaitlistStudent${i}`,
          lastName: 'Test',
          email: `waitlist-student-${i}-${uniqueSuffix}@test.local`,
          incomeTier: i + 1, // tiers 2, 3, 4
        },
      });
      studentIds.push(student.id);
    }
  });

  afterAll(async () => {
    // Clean up in dependency order: waitlist entries → registrations → class
    // → students → teacherRoom → room → teacher. Filtered by teacherId, not
    // just the fixed [classId, notFullClassId, draftClassId] ids, so this
    // also sweeps the classes the nested `closeQueueOnStart` describe below
    // creates inline via `makeClass`. A test that dies before reaching its
    // own inline cleanup — which the mutation-testing protocol guarantees
    // will happen — must not leave a class behind that then breaks this
    // teardown's `teacherRoom` delete on an FK violation, the way an
    // id-list-scoped version did. Same fix as the sibling `afterAll`s in
    // `class-transitions.test.ts` and `class-lifecycle.test.ts`.
    await prisma.waitlistEntry.deleteMany({ where: { class: { teacherId } } });
    await prisma.registration.deleteMany({ where: { class: { teacherId } } });
    await prisma.class.deleteMany({ where: { teacherId } });
    for (const sid of [...studentIds, ...fillerIds]) {
      await prisma.student.delete({ where: { id: sid } });
    }
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('adds students with sequential positions', async () => {
    const entry1 = await addToWaitlist(prisma, classId, studentIds[0]!);
    expect(entry1.position).toBe(1);
    expect(entry1.status).toBe('waiting');
    expect(entry1.classId).toBe(classId);
    expect(entry1.studentId).toBe(studentIds[0]);

    const entry2 = await addToWaitlist(prisma, classId, studentIds[1]!);
    expect(entry2.position).toBe(2);

    const entry3 = await addToWaitlist(prisma, classId, studentIds[2]!);
    expect(entry3.position).toBe(3);
  });

  it('joining again while already waiting is a no-op', async () => {
    const again = await addToWaitlist(prisma, classId, studentIds[0]!);
    expect(again.position).toBe(1);
    const entries = await prisma.waitlistEntry.findMany({
      where: { classId, studentId: studentIds[0]! },
    });
    expect(entries).toHaveLength(1);
  });

  it('rejects joining when the class still has open spots', async () => {
    await expect(addToWaitlist(prisma, notFullClassId, studentIds[0]!)).rejects.toThrowError(
      WaitlistJoinError,
    );
    await expect(
      addToWaitlist(prisma, notFullClassId, studentIds[0]!),
    ).rejects.toMatchObject({ reason: 'class_not_full' });
  });

  it('rejects joining a class that is not open', async () => {
    await expect(addToWaitlist(prisma, draftClassId, studentIds[0]!)).rejects.toMatchObject({
      reason: 'class_not_open',
    });
  });

  it('rejects joining when already actively registered', async () => {
    await expect(addToWaitlist(prisma, classId, fillerIds[0]!)).rejects.toMatchObject({
      reason: 'already_registered',
    });
  });

  it('reorders remaining entries after removing a middle student', async () => {
    // Remove middle student (position 2)
    await removeFromWaitlist(prisma, classId, studentIds[1]!);

    // Verify the removed entry has status 'removed'
    const removedEntry = await prisma.waitlistEntry.findUnique({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });
    expect(removedEntry?.status).toBe('removed');

    // Verify remaining 'waiting' entries are reordered to 1, 2
    const remaining = await prisma.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.studentId).toBe(studentIds[0]);
    expect(remaining[0]!.position).toBe(1);
    expect(remaining[1]!.studentId).toBe(studentIds[2]);
    expect(remaining[1]!.position).toBe(2);
  });

  it('rejoining reactivates the removed entry at the back of the queue', async () => {
    const removed = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });

    const rejoined = await addToWaitlist(prisma, classId, studentIds[1]!);
    expect(rejoined.id).toBe(removed.id); // same row, reactivated
    expect(rejoined.status).toBe('waiting');
    expect(rejoined.position).toBe(3); // back of the queue, not old position

    const entries = await prisma.waitlistEntry.findMany({
      where: { classId, studentId: studentIds[1]! },
    });
    expect(entries).toHaveLength(1);
  });

  describe('closeQueueOnStart', () => {
    it('closes every waiting row to expired and leaves other statuses alone', async () => {
      const closingClassId = await makeClass('in_progress', 2);
      await prisma.waitlistEntry.createMany({
        data: [
          { classId: closingClassId, studentId: studentIds[0]!, position: 1, status: 'waiting' },
          { classId: closingClassId, studentId: studentIds[1]!, position: 2, status: 'removed' },
          { classId: closingClassId, studentId: studentIds[2]!, position: 3, status: 'promoted' },
        ],
      });

      const closed = await prisma.$transaction((tx) => closeQueueOnStart(tx, closingClassId));

      // Row-level evidence first: this is what a `where`-predicate mutation
      // (e.g. keying on `not: 'expired'` instead of `waiting`) actually gets
      // wrong, and asserting it before the count below means a broken
      // predicate fails here, on the rows it corrupted, rather than only on
      // the count.
      const rows = await prisma.waitlistEntry.findMany({
        where: { classId: closingClassId },
        orderBy: { position: 'asc' },
        select: { position: true, status: true },
      });
      // Three distinct statuses, so no off-by-one predicate reproduces this.
      // `removed` and `promoted` are BOTH present because a helper that wrote
      // every row, or that keyed on `not: 'expired'`, would pass against
      // either one alone.
      expect(rows).toEqual([
        { position: 1, status: 'expired' },
        { position: 2, status: 'removed' },
        { position: 3, status: 'promoted' },
      ]);
      expect(closed).toBe(1);

      await prisma.waitlistEntry.deleteMany({ where: { classId: closingClassId } });
      await prisma.class.delete({ where: { id: closingClassId } });
    });

    it('returns 0 and writes nothing when there is no queue', async () => {
      const closingClassId = await makeClass('in_progress', 2);
      const closed = await prisma.$transaction((tx) => closeQueueOnStart(tx, closingClassId));
      expect(closed).toBe(0);
      await prisma.class.delete({ where: { id: closingClassId } });
    });

    it('leaves another class queue untouched', async () => {
      const mineClassId = await makeClass('in_progress', 2);
      const theirsClassId = await makeClass('open', 2);
      await prisma.waitlistEntry.createMany({
        data: [
          { classId: mineClassId, studentId: studentIds[0]!, position: 1, status: 'waiting' },
          { classId: theirsClassId, studentId: studentIds[0]!, position: 1, status: 'waiting' },
        ],
      });

      await prisma.$transaction((tx) => closeQueueOnStart(tx, mineClassId));

      const other = await prisma.waitlistEntry.findFirstOrThrow({
        where: { classId: theirsClassId },
      });
      expect(other.status).toBe('waiting');

      await prisma.waitlistEntry.deleteMany({
        where: { classId: { in: [mineClassId, theirsClassId] } },
      });
      await prisma.class.deleteMany({ where: { id: { in: [mineClassId, theirsClassId] } } });
    });
  });

  /**
   * Whole-branch review of #216/#182. A student's `/bookings` page
   * rendered while their entry was still `waiting`; by the time they tap
   * "Leave waitlist" the class has started and `closeQueueOnStart` already
   * flipped the row to `expired`. Before this fix `removeFromWaitlist`'s
   * unconditional write overwrote it to `removed` anyway — turning "never
   * got in" into "withdrew", the wrong story #216 exists to prevent, one
   * status over. Scoping the write to `status: 'waiting'` refuses this as a
   * no-op instead.
   */
  it('refuses to overwrite an expired entry rather than reporting it removed', async () => {
    const staleClassId = await makeClass('in_progress', 2);
    await prisma.waitlistEntry.create({
      data: { classId: staleClassId, studentId: studentIds[0]!, position: 1, status: 'expired' },
    });

    // `NOT_WAITING`, not `NOT_FOUND`. The row is right there — the student can
    // see it, and so can their Article 15 export — it is simply no longer
    // theirs to leave. The route answers this with a 409 and a refresh rather
    // than denying the entry exists.
    const result = await removeFromWaitlist(prisma, staleClassId, studentIds[0]!);
    expect(result).toEqual({ ok: false, reason: 'NOT_WAITING' });

    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId: staleClassId, studentId: studentIds[0]! } },
    });
    expect(entry.status).toBe('expired');

    await prisma.waitlistEntry.deleteMany({ where: { classId: staleClassId } });
    await prisma.class.delete({ where: { id: staleClassId } });
  });

  /**
   * #104. `addToWaitlist` took an unbounded inline `FOR UPDATE` until this
   * change; it now goes through `lockClassRow`, which issues the shared 2s
   * `SET LOCAL lock_timeout` first.
   *
   * The 3.5s hold is the guard, not scenery: it sits above the 2s bound and
   * below Prisma's 5s default transaction budget, so WITHOUT the bound this
   * call acquires the lock at 3.5s and succeeds. Reverting the site to its
   * inline statement therefore fails `expect(outcome.ok).toBe(false)` rather
   * than hanging the suite.
   *
   * `outcome.ok === false` is what distinguishes "gave up at 2s" from "waited
   * the holder out", and it is the only thing that can: waiting the holder out
   * does not fail slowly, it SUCCEEDS at 3.5s. `/55P03/` then names the
   * mechanism as Postgres's `lock_timeout` rather than some other refusal, and
   * `waited > 1_000` excludes an instant failure that never reached the lock.
   *
   * There is deliberately NO upper bound on `waited`, and this paragraph is
   * the reference for the two sibling guards below (`promoteNext (DB)` and
   * `claimSpot (DB)`) and for the HTTP one in
   * `tests/integration/registrations-api.test.ts`. All four carried
   * `toBeLessThan(3_400)`. It was not dead weight for every value, though: a
   * `lock_timeout` configured between 3.4s and 3.5s — say 3.45s — still sits
   * below the 3.5s hold, so the call still raises `55P03` and `ok === false`
   * and `/55P03/` both stay green while `waited` lands past the 3_400 ceiling.
   * That was its one sliver of unique coverage. Everywhere else it was
   * redundant with the other two assertions: at a 3.0s or 3.3s bound the call
   * raises `55P03` and passes the ceiling anyway; at 3.6s it acquires when the
   * holder releases and succeeds, which `ok === false` catches on its own.
   * And that one sliver is already pinned directly — `db-locks.test.ts`
   * asserts the literal `LOCK_TIMEOUT_SQL` value and observes the effect via
   * `SHOW lock_timeout` — so the ceiling was never the only thing standing
   * between a misconfigured bound and a green suite. What it cost instead was
   * a ~1400ms overhead budget, against a holder-acquisition latency this same
   * file measured at 486ms under load and 428ms idle on a 10-core machine —
   * so on a 2-4 core CI box running three vitest projects it was the one
   * flake surface in these guards, reddening at random under a label that
   * sent the reader looking for a bound which had in fact fired correctly.
   * The timeout's VALUE is pinned by `db-locks.test.ts`, never by a
   * wall-clock threshold here.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Its own full class: max 1, one registration. Not the block's shared
    // `classId`, whose waitlist other tests mutate.
    const lockedClassId = await makeClass('open', 1);
    await prisma.registration.create({
      data: {
        classId: lockedClassId,
        studentId: fillerIds[0]!,
        status: 'registered',
        tierAtBooking: 3,
      },
    });

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await addToWaitlist(prisma, lockedClassId, studentIds[0]!).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);
  }, 20_000);
});

describe('promoteNext (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];
  const fillerIds: string[] = [];

  async function cancelRegistration(studentId: string): Promise<void> {
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
  }

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Promote',
        lastName: 'Teacher',
        email: `promote-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `promote-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for promote tests',
        pageSlug: `promote-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Promote Studio',
        address: `${uniqueSuffix} Promote St`,
        city: 'Amsterdam',
        postcode: '5678PR',
        floor: '2',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId,
        capacityOverride: 15,
        rentalRate: 35,
      },
    });
    teacherRoomId = teacherRoom.id;

    // Two spots, both taken by fillers — students join a genuinely full class.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Yin',
        date: new Date('2099-07-01'),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 75,
        roomCost: 40,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 2,
        status: 'open',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    for (let i = 1; i <= 2; i++) {
      const filler = await prisma.student.create({
        data: {
          firstName: `PromoteFiller${i}`,
          lastName: 'Test',
          email: `promote-filler-${i}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
      });
      fillerIds.push(filler.id);
      await prisma.registration.create({
        data: { classId, studentId: filler.id, status: 'registered', tierAtBooking: 3 },
      });
    }

    // Create 4 students (2 for plain promotion, 2 for the stale-head case)
    for (let i = 1; i <= 4; i++) {
      const student = await prisma.student.create({
        data: {
          firstName: `PromoteStudent${i}`,
          lastName: 'Test',
          email: `promote-student-${i}-${uniqueSuffix}@test.local`,
          incomeTier: i + 1, // tiers 2, 3, 4, 5
        },
      });
      studentIds.push(student.id);
    }

    // Add the first two students to the waitlist
    await addToWaitlist(prisma, classId, studentIds[0]!);
    await addToWaitlist(prisma, classId, studentIds[1]!);
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    for (const sid of [...studentIds, ...fillerIds]) {
      await prisma.student.delete({ where: { id: sid } });
    }
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('promotes the first waiting student and creates a registration', async () => {
    await cancelRegistration(fillerIds[0]!); // free one spot

    const promoted = await promoteNext(prisma, classId);
    expect(promoted).not.toBeNull();
    expect(promoted!.status).toBe('promoted');
    expect(promoted!.studentId).toBe(studentIds[0]);
    expect(promoted!.promotedAt).not.toBeNull();
    expect(promoted!.registrationId).not.toBeNull();

    // Verify a Registration was created
    const registration = await prisma.registration.findUnique({
      where: { id: promoted!.registrationId! },
    });
    expect(registration).not.toBeNull();
    expect(registration!.classId).toBe(classId);
    expect(registration!.studentId).toBe(studentIds[0]);
    expect(registration!.status).toBe('registered');
    expect(registration!.tierAtBooking).toBe(2); // incomeTier of student 1

    // Verify remaining waitlist entries are reordered
    const remaining = await prisma.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.studentId).toBe(studentIds[1]);
    expect(remaining[0]!.position).toBe(1);
  });

  it('promotes the second student when another spot frees', async () => {
    await cancelRegistration(fillerIds[1]!);

    const promoted = await promoteNext(prisma, classId);
    expect(promoted).not.toBeNull();
    expect(promoted!.studentId).toBe(studentIds[1]);
    expect(promoted!.status).toBe('promoted');
  });

  it('returns null when no waiting students remain', async () => {
    await cancelRegistration(studentIds[0]!); // free a spot, queue is empty
    const result = await promoteNext(prisma, classId);
    expect(result).toBeNull();
  });

  it('skips and removes a stale head whose student already booked directly', async () => {
    // Queue up two students (class is full again after this setup: the
    // stale student's direct booking takes the spot freed in the previous
    // test). studentIds[2] joins the waitlist, then books directly — the
    // exact race that used to wedge the queue on the unique constraint.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[2]!, status: 'registered', tierAtBooking: 4 },
    });
    await addToWaitlist(prisma, classId, studentIds[3]!);
    // Manufacture the stale entry directly — the API resolves it on booking,
    // but a claim/promotion race can still leave one behind.
    const stale = await prisma.waitlistEntry.update({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
      data: { status: 'waiting', position: 0, registrationId: null, promotedAt: null },
    });
    expect(stale.position).toBe(0); // head of the queue, already registered

    await cancelRegistration(studentIds[2]!); // free a spot

    const promoted = await promoteNext(prisma, classId);
    expect(promoted).not.toBeNull();
    expect(promoted!.studentId).toBe(studentIds[3]); // stale head skipped

    const staleAfter = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });
    expect(staleAfter.status).toBe('removed');
  });

  it('reactivates a cancelled registration row instead of failing on the unique constraint', async () => {
    // studentIds[2] cancelled in the previous test — their registration row
    // still exists. Rejoin the waitlist and promote: the old row must be
    // reused, not tripped over.
    const oldRegistration = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[2]! } },
    });
    expect(oldRegistration.status).toBe('cancelled');

    await addToWaitlist(prisma, classId, studentIds[2]!);
    await cancelRegistration(studentIds[3]!); // free a spot

    const promoted = await promoteNext(prisma, classId);
    expect(promoted).not.toBeNull();
    expect(promoted!.studentId).toBe(studentIds[2]);
    expect(promoted!.registrationId).toBe(oldRegistration.id); // same row, reactivated

    const reactivated = await prisma.registration.findUniqueOrThrow({
      where: { id: oldRegistration.id },
    });
    expect(reactivated.status).toBe('registered');
    expect(reactivated.cancelledAt).toBeNull();
  });

  it('refuses to promote into a class that is exactly at maxStudents', async () => {
    // The class is at capacity (s1 and s2 promoted above) and the queue is
    // empty — re-queue a student who holds no registration, so the capacity
    // guard is the only thing between this call and a promotion. The class
    // is dated 2099 and the instant is two months before it, so the window
    // is auto_promote; freeSeats === 0 must still throw class_full. This is
    // the test mutation M6 found missing.
    const extra = await prisma.student.create({
      data: {
        firstName: 'PromoteExtra',
        lastName: 'Test',
        email: `promote-extra-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    try {
      await addToWaitlist(prisma, classId, extra.id);

      const promise = promoteNext(prisma, classId, { now: new Date('2099-06-01T12:00:00Z') });
      await expect(promise).rejects.toBeInstanceOf(WaitlistPromotionError);
      await promise.catch((err: unknown) => {
        expect((err as WaitlistPromotionError).reason).toBe('class_full');
      });

      // Nothing changed: no promotion, no registration.
      expect(
        await prisma.registration.count({ where: { classId, studentId: extra.id } }),
      ).toBe(0);
    } finally {
      await prisma.waitlistEntry.deleteMany({ where: { classId, studentId: extra.id } });
      await prisma.student.delete({ where: { id: extra.id } });
    }
  });

  /**
   * #104. `promoteNext` is the one converted site that is NOT a route. It is
   * called only by `handleSpotFreed`, which `reconcileWaitlists` re-invokes
   * every minute — `waitlist-reconciliation.ts`'s own docblock puts it as
   * "this module detects; `handleSpotFreed` decides". So its failure surface
   * is the reconciliation sweep repairing it later, not a 503 a student reads.
   *
   * The bound is a TRADE here, not a free improvement, and the trade is worth
   * stating because both directions are real. What it buys: a contended
   * promotion used to wait out the WHOLE hold and then blow Prisma's 5s budget
   * (`P2028`, measured at 7014ms against a 7s hold — it cannot cancel a
   * statement already blocked inside Postgres), occupying a pool connection
   * the whole time; now it aborts at 2s with `55P03` and the sweep retries
   * sooner. What it costs: before the conversion a promotion still SUCCEEDED
   * against a competing hold of up to roughly 4.5s (the 5s budget less the
   * 8-12 statements that still have to run after the lock is won — spec §3.3).
   * `2s < h ≲ 4.5s` is therefore a band where a promotion that used to happen
   * no longer does on the live path.
   *
   * That band is not invisible. `reconcileWaitlists` catches per class, and
   * `report` throws `ReconciliationFailedError` when every class it invoked
   * failed (`waitlist-reconciliation.ts`); `scheduler.ts` stores that as the
   * job's `lastError`, and `/api/health` reports `degraded` while it is set.
   * On a single-teacher VPS one candidate class per tick is the ordinary case,
   * so "every class failed" is reachable from a single benign lock race that
   * the next tick repairs. Changing that error semantics is filed separately;
   * it is not this test's business, but a reader of this comment should not
   * come away thinking the trade has no downstream.
   *
   * The 3.5s hold sits above the 2s bound and below the 5s budget, so without
   * the bound this call acquires at 3.5s and succeeds. `outcome.ok === false`
   * is therefore the discriminator, `/55P03/` names the mechanism, and
   * `waited > 1_000` excludes an instant unrelated failure — see the sibling
   * guard in `addToWaitlist + removeFromWaitlist (DB)` above for why there is
   * no upper bound on `waited`, and for why the ceiling that used to be here
   * was worth deleting even though it had one sliver of coverage: that sliver
   * is already pinned directly by `db-locks.test.ts`.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Its own full class: max 1, one filler registered (making it full,
    // which `addToWaitlist` requires), a second filler waitlisted, then that
    // registration cancelled to free the seat. Not the block's shared
    // `classId` — its queue is consumed in a fixed order by `beforeAll` and
    // the tests above, so a guard appended there would depend on that order.
    // `cancelRegistration` above closes over the shared `classId` and can't
    // target this class, so its update is inlined below.
    const lockedClass = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Yin',
        date: new Date('2099-07-01'),
        startTime: hhmmToTime('19:00'),
        durationMinutes: 75,
        roomCost: 40,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 1,
        status: 'open',
        settingsLocked: true,
      },
    });
    const lockedClassId = lockedClass.id;

    try {
      await prisma.registration.create({
        data: {
          classId: lockedClassId,
          studentId: fillerIds[0]!,
          status: 'registered',
          tierAtBooking: 3,
        },
      });
      await addToWaitlist(prisma, lockedClassId, fillerIds[1]!);
      await prisma.registration.update({
        where: { classId_studentId: { classId: lockedClassId, studentId: fillerIds[0]! } },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });

      const holderClient = new PrismaClient();
      let signalHeld!: () => void;
      const held = new Promise<void>((r) => {
        signalHeld = r;
      });

      const holder = holderClient.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
          signalHeld();
          await new Promise((r) => setTimeout(r, 3_500));
        },
        { timeout: 30_000 },
      );
      await held;

      const startedAt = Date.now();
      const outcome = await promoteNext(prisma, lockedClassId).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err: String(err) }),
      );
      const waited = Date.now() - startedAt;

      await holder;
      await holderClient.$disconnect();

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
      expect(waited).toBeGreaterThan(1_000);
    } finally {
      await prisma.waitlistEntry.deleteMany({ where: { classId: lockedClassId } });
      await prisma.registration.deleteMany({ where: { classId: lockedClassId } });
      await prisma.class.delete({ where: { id: lockedClassId } });
    }
  }, 20_000);
});

// ===========================================================================
// claimSpot — the first-come-first-claimed window matrix
// ===========================================================================

/**
 * `claimSpot` had no unit coverage of any kind: its only execution under test
 * anywhere was one HTTP case from #64, which had to reach the claim window
 * with a wall-clock-relative fixture. It takes an injectable clock, so the
 * whole matrix can be pinned deterministically here instead — and the guards
 * fire in a fixed order (status → window → capacity → entry), so each case
 * below has to satisfy every guard ahead of the one it targets.
 */
describe('claimSpot (DB)', () => {
  // One fixed class drives every instant, so nothing here reads the wall clock:
  //   class starts       2026-06-01 09:00 UTC  (teacher default timezone UTC)
  //   HOURS_24        →  deadline 2026-05-31 09:00 UTC
  //   cutoff = deadline − 1h        2026-05-31 08:00 UTC
  const BEFORE_CUTOFF = new Date('2026-05-30T12:00:00Z');
  const IN_CLAIM_WINDOW = new Date('2026-05-31T08:30:00Z');
  // Exactly the deadline: the comparison is `>=`, so this is the first frozen
  // instant, not the last claimable one.
  const AT_DEADLINE = new Date('2026-05-31T09:00:00Z');

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let fillerId: string;
  let waiterId: string;
  let outsiderId: string;
  const classIds: string[] = [];
  // Extra teachers (and their accounts) created below for calls after the
  // first — see makeFullClass's comment.
  const extraTeacherIds: string[] = [];
  const extraAccountIds: string[] = [];

  /**
   * A full, open class with `waiter` on its waitlist — the state every claim
   * starts from. `maxStudents: 1` plus one registration is the cheapest way to
   * be full, which is what `addToWaitlist` requires before it will accept
   * anyone.
   *
   * date/startTime are load-bearing for the deadline-window comment above
   * (BEFORE_CUTOFF/IN_CLAIM_WINDOW/AT_DEADLINE are all computed against this
   * exact 2026-06-01 09:00 UTC start) — moving either to dodge
   * Class_teacher_slot_unique across this describe's 6 calls would shift
   * every boundary those constants were pinned against. So every call after
   * the first gets its own teacher (defaultTimezone UTC, matching the
   * fixture teacher below, since claimSpot reads the deadline off
   * `cls.teacher.defaultTimezone`) instead — the index is scoped per
   * teacher, so a different owner keeps the same slot legal.
   * `teacherRoomId` is reused across those teachers deliberately: claimSpot
   * never reads it, and slot-constraints.test.ts already establishes that
   * Class.teacherRoomId need not belong to Class.teacherId.
   */
  let makeFullClassCounter = 0;
  const makeFullClass = async (): Promise<string> => {
    makeFullClassCounter += 1;
    let classTeacherId = teacherId;
    if (makeFullClassCounter > 1) {
      const mail = `claim-teacher-${makeFullClassCounter}-${uniqueSuffix}@test.local`;
      const extraTeacher = await prisma.teacher.create({
        data: {
          firstName: 'Claim',
          lastName: `Teacher${makeFullClassCounter}`,
          email: mail,
          account: { create: { email: mail } },
          bio: 'Test teacher for claimSpot tests',
          pageSlug: `claim-teacher-${makeFullClassCounter}-${uniqueSuffix}`,
          defaultTimezone: 'UTC',
        },
      });
      extraTeacherIds.push(extraTeacher.id);
      extraAccountIds.push(extraTeacher.accountId);
      classTeacherId = extraTeacher.id;
    }

    const cls = await prisma.class.create({
      data: {
        teacherId: classTeacherId,
        teacherRoomId,
        classType: 'Claim Flow',
        date: new Date('2026-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      },
    });
    classIds.push(cls.id);
    await prisma.registration.create({
      data: { classId: cls.id, studentId: fillerId, tierAtBooking: 3 },
    });
    await addToWaitlist(prisma, cls.id, waiterId);
    return cls.id;
  };

  /** Frees the single spot, so a claim can get past the capacity guard. */
  const freeTheSpot = (classId: string) =>
    prisma.registration.update({
      where: { classId_studentId: { classId, studentId: fillerId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

  beforeAll(async () => {
    const mail = `claim-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Claim',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for claimSpot tests',
        pageSlug: `claim-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Claim Studio',
        address: `${uniqueSuffix} Claim St`,
        city: 'Amsterdam',
        postcode: '9012CL',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;

    const mk = async (label: string) =>
      (
        await prisma.student.create({
          data: {
            firstName: 'Claim',
            lastName: label,
            email: `claim-${label}-${uniqueSuffix}@test.local`,
            incomeTier: 4,
          },
        })
      ).id;
    fillerId = await mk('filler');
    waiterId = await mk('waiter');
    outsiderId = await mk('outsider');
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    await prisma.student.deleteMany({ where: { id: { in: [fillerId, waiterId, outsiderId] } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.teacher.deleteMany({ where: { id: { in: extraTeacherIds } } });
    // Teacher.accountId has no onDelete: Cascade (slot-constraints.test.ts's
    // makeTeacher carries the same note), so these survive the teacher
    // deletes above and must be removed separately, only after them —
    // Account is what Teacher.accountId references.
    await prisma.account.deleteMany({ where: { id: { in: [accountId, ...extraAccountIds] } } });
    await prisma.$disconnect();
  });

  const expectRejection = async (
    promise: Promise<unknown>,
    reason: WaitlistPromotionError['reason'],
  ) => {
    await expect(promise).rejects.toBeInstanceOf(WaitlistPromotionError);
    await promise.catch((err: unknown) => {
      expect((err as WaitlistPromotionError).reason).toBe(reason);
    });
  };

  it('refuses a claim before the final hour — the queue auto-promotes then', async () => {
    const classId = await makeFullClass();
    await freeTheSpot(classId);

    // The spot is free and the student is waiting; only the clock is wrong.
    await expectRejection(
      claimSpot(prisma, classId, waiterId, BEFORE_CUTOFF),
      'wrong_window',
    );
    expect(
      await prisma.registration.count({ where: { classId, studentId: waiterId } }),
    ).toBe(0);
  });

  it('refuses a claim once the cancellation deadline has passed', async () => {
    const classId = await makeFullClass();
    await freeTheSpot(classId);

    // Boundary case: exactly the deadline instant is already frozen.
    await expectRejection(claimSpot(prisma, classId, waiterId, AT_DEADLINE), 'window_frozen');
  });

  it('refuses a claim when the spot has already been taken', async () => {
    const classId = await makeFullClass();
    // Deliberately do NOT free the spot: the class is still at capacity.

    await expectRejection(
      claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW),
      'class_full',
    );
  });

  it('refuses a claim from a student who is not on the waitlist', async () => {
    const classId = await makeFullClass();
    await freeTheSpot(classId);

    // The capacity guard runs before the entry guard, which is why the spot
    // has to be free for this case to reach the branch it is testing.
    await expectRejection(
      claimSpot(prisma, classId, outsiderId, IN_CLAIM_WINDOW),
      'entry_not_waiting',
    );
  });

  it('refuses a claim on a class that is no longer open', async () => {
    const classId = await makeFullClass();
    await freeTheSpot(classId);
    // Cancelled after the waitlist formed — the status guard runs first, so
    // this fires even though the window and capacity are both fine.
    await prisma.class.update({ where: { id: classId }, data: { status: 'cancelled' } });

    await expectRejection(
      claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW),
      'class_not_open',
    );
  });

  it('claims the spot: registration created at the student’s tier, entry promoted, student notified', async () => {
    const classId = await makeFullClass();
    await freeTheSpot(classId);

    const entry = await claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW);

    expect(entry.status).toBe('promoted');
    expect(entry.promotedAt).not.toBeNull();
    expect(entry.registrationId).not.toBeNull();

    const registration = await prisma.registration.findUniqueOrThrow({
      where: { id: entry.registrationId! },
    });
    expect(registration.studentId).toBe(waiterId);
    expect(registration.status).toBe('registered');
    // Captured from the student's current tier at claim time — this is the
    // income history the pricing engine bills against later.
    expect(registration.tierAtBooking).toBe(4);

    const notifications = await prisma.notification.findMany({
      where: { relatedClassId: classId, recipientId: waiterId, recipientType: 'student' },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.type).toBe('booking_confirmed');
  });

  /**
   * #104. `claimSpot` took an unbounded inline `FOR UPDATE` until this change;
   * it now goes through `lockClassRow` and its shared 2s bound.
   *
   * This is the site where contention is by DESIGN: the final-hour broadcast
   * tells every waiting student at once, so N claims land on one `Class` row
   * and serialize. That is not what the bound is for — each claim holds the
   * row only for its own short transaction, so 2s covers a deep queue
   * comfortably. What the bound stops is a claim arriving while an UNRELATED
   * long holder has the row: a GDPR erasure holds, for up to 20s, every class
   * the erased student was QUEUED in — `deleteStudentAccount` pre-locks on a
   * join over `WaitlistEntry` (`gdpr.ts`), across every entry status, not on
   * registrations. A class the student was registered in but never queued in
   * is written UNLOCKED by that same erasure, a distinction `handleSpotFreed`
   * makes deliberately in `waitlist.ts` — so "every class a student touched"
   * would name a wider lock set than the one that actually exists.
   *
   * The 3.5s hold is the guard. It sits above the 2s bound and below Prisma's
   * 5s default budget, so WITHOUT the bound this call acquires at 3.5s and
   * succeeds — reverting the site fails `expect(outcome.ok).toBe(false)`
   * rather than hanging the suite. That failure IS what separates "gave up at
   * 2s" from "waited it out"; see the sibling guard in
   * `addToWaitlist + removeFromWaitlist (DB)` above for why there is no upper
   * bound on `waited`, and for why the ceiling that used to be here was worth
   * deleting even though it had one sliver of coverage: that sliver is
   * already pinned directly by `db-locks.test.ts`.
   */
  it('gives up on the 2s bound when another transaction holds the class row', async () => {
    // Same state the passing test above builds: in the claim window, one
    // free spot, this student `waiting`.
    const lockedClassId = await makeFullClass();
    await freeTheSpot(lockedClassId);

    const holderClient = new PrismaClient();
    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });

    const holder = holderClient.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${lockedClassId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const outcome = await claimSpot(prisma, lockedClassId, waiterId, IN_CLAIM_WINDOW).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );
    const waited = Date.now() - startedAt;

    await holder;
    await holderClient.$disconnect();

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03/);
    expect(waited).toBeGreaterThan(1_000);
  }, 20_000);
});

// ===========================================================================
// The join is the consenting act — link creation and invitation resolution
// ===========================================================================

/**
 * #166. The `TeacherStudent` link is created at the JOIN, not at the
 * promotion: joining is student-initiated and aimed at one named teacher,
 * exactly like booking, whereas a promotion fires at a moment the teacher
 * picks (cancel any registration → `handleSpotFreed` → `promoteNext`). This
 * describe covers what a join writes beyond the `WaitlistEntry` on each of
 * `addToWaitlist`'s three exits, and what a promotion no longer writes.
 *
 * Every student address here used to carry uppercase, deliberately, so an
 * all-lowercase fixture couldn't make `resolveInvitationOnLink`'s bridging
 * indistinguishable from its absence (#166 F1). That row is unrepresentable
 * now: `Student_email_lowercase_check` (#170 Task 2) rejects it, and the
 * bridging itself is gone — `resolveInvitationOnLink` asserts its input is
 * already lowercase (`requireNormalised`, src/lib/schemas.ts) rather than
 * normalising it (#170 Task 3). Every address below is lowercase by
 * construction, matching what the column now enforces.
 */
describe('addToWaitlist links the student and resolves their invitation (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  /** Full and open: the only state `addToWaitlist` accepts a join in. */
  let fullClassId: string;
  /** Has spare capacity, so every join is refused — the guard case. */
  let notFullClassId: string;
  /** Full, `auto_promote` window, one filler to cancel: the promotion case. */
  let promoteClassId: string;

  const classIds: string[] = [];
  const studentIds: string[] = [];
  /** Student id → that student's (lowercase) address. */
  const emailOf = new Map<string, string>();

  let pendingId: string;
  let declinedId: string;
  let noopId: string;
  let guardId: string;
  /** Reaches the create exit, then fails there — the rollback case. */
  let rollbackId: string;
  let promoteId: string;
  let fillerId: string;
  let promoteFillerId: string;

  /** The row whose presence or absence every test here turns on. */
  const link = (studentId: string) =>
    prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    });

  const invitationOf = (studentId: string) =>
    prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: emailOf.get(studentId)! } },
    });

  /**
   * A student, plus (optionally) the invitation this teacher sent them —
   * both lowercase, the way `inviteContact` writes an invitation and the
   * way `Student_email_lowercase_check` (#170) now requires a Student row
   * to be.
   */
  const makeStudent = async (
    label: string,
    invitation?: { status: 'pending' | 'declined'; blocked?: boolean },
  ): Promise<string> => {
    const email = `Join-${label}-${uniqueSuffix}@Test.Local`.toLowerCase();
    const student = await prisma.student.create({
      data: { firstName: 'Join', lastName: label, email, incomeTier: 3 },
      select: { id: true },
    });
    studentIds.push(student.id);
    emailOf.set(student.id, email);
    if (invitation) {
      await prisma.invitation.create({
        data: {
          teacherId,
          email,
          firstName: 'Join',
          lastName: label,
          status: invitation.status,
          respondedAt: invitation.status === 'declined' ? new Date() : null,
        },
      });
      if (invitation.blocked) {
        await prisma.teacherBlock.create({ data: { teacherId, email } });
      }
    }
    return student.id;
  };

  beforeAll(async () => {
    const mail = `join-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Join',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for join-link tests',
        pageSlug: `join-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Join Studio',
        address: `${uniqueSuffix} Join St`,
        city: 'Amsterdam',
        postcode: '3456JN',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
    });
    teacherRoomId = teacherRoom.id;

    // 2099 keeps every class in the `auto_promote` window, so `promoteNext`'s
    // own window guard never trips — the same trick the describes above use.
    // Counter-derived startTime: this beforeAll calls makeClass 3 times for
    // one teacher/date, and none of this describe's tests read or assert the
    // created rows' literal startTime — so a distinct minute per call is
    // enough to keep every create legal under Class_teacher_slot_unique.
    // Routed through the module-level `slotTime` at a `10:xx` offset
    // (`slotTime(60 + counter)`) rather than a raw `10:${counter}` literal.
    let makeClassCounter = 0;
    const makeClass = async (label: string, maxStudents: number): Promise<string> => {
      makeClassCounter += 1;
      const cls = await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: label,
          date: new Date('2099-08-01'),
          startTime: hhmmToTime(slotTime(60 + makeClassCounter)),
          durationMinutes: 60,
          roomCost: 25,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents,
          status: 'open',
          settingsLocked: true,
        },
      });
      classIds.push(cls.id);
      return cls.id;
    };

    fullClassId = await makeClass('Join Full', 1);
    notFullClassId = await makeClass('Join Not Full', 12);
    promoteClassId = await makeClass('Join Promote', 1);

    pendingId = await makeStudent('Pending', { status: 'pending' });
    declinedId = await makeStudent('Declined', { status: 'declined', blocked: true });
    noopId = await makeStudent('Noop', { status: 'pending' });
    guardId = await makeStudent('Guard', { status: 'pending' });
    rollbackId = await makeStudent('Rollback', { status: 'pending' });
    promoteId = await makeStudent('Promote', { status: 'pending' });
    fillerId = await makeStudent('Filler');
    promoteFillerId = await makeStudent('PromoteFiller');

    // One registration each takes the single spot, which is what makes the
    // class full — `addToWaitlist` refuses a join otherwise.
    await prisma.registration.create({
      data: { classId: fullClassId, studentId: fillerId, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.registration.create({
      data: {
        classId: promoteClassId,
        studentId: promoteFillerId,
        status: 'registered',
        tierAtBooking: 3,
      },
    });
  });

  afterAll(async () => {
    // Promotions write a notification whose `recipientId` carries no FK, so
    // it does not cascade with the student — same reasoning as the describes
    // above.
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    // Invitations, blocks and any surviving links go with the teacher.
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('joining a full class creates the link and accepts a pending invitation', async () => {
    // The starting state is the test: no link, invitation unanswered.
    expect(await link(pendingId)).toBeNull();
    expect((await invitationOf(pendingId)).status).toBe('pending');

    const entry = await addToWaitlist(prisma, fullClassId, pendingId);
    expect(entry.status).toBe('waiting');

    expect(await link(pendingId)).not.toBeNull();
    const invitation = await invitationOf(pendingId);
    expect(invitation.status).toBe('accepted');
    expect(invitation.respondedAt).not.toBeNull();
  });

  it('joining reverses a decline and clears the block — the way back, through the queue', async () => {
    // Seeded at `declined` with a live block: the state a join has to move
    // AWAY from. A fixture seeded at `accepted` asserting `accepted` cannot
    // tell a working resolve from one that never ran.
    expect((await invitationOf(declinedId)).status).toBe('declined');
    expect(
      await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email: emailOf.get(declinedId)! } },
      }),
    ).not.toBeNull();

    await addToWaitlist(prisma, fullClassId, declinedId);

    expect(await link(declinedId)).not.toBeNull();
    // The block, not just the invitation: the block is the thing that
    // actually stands between them, and `delivered` is the only signal a
    // future invitation would carry.
    expect(
      await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email: emailOf.get(declinedId)! } },
      }),
    ).toBeNull();
    expect((await invitationOf(declinedId)).status).toBe('accepted');
  });

  it('the already-waiting no-op path writes the link too, so the three exits agree', async () => {
    // A `waiting` row with no link is reachable two ways: it predates this
    // change, or an unlink committed just after a join (see
    // `withdrawWaitingEntriesForTeacher`). Either way the student's next
    // join must repair it — and that join returns early, so a link written
    // after the early return would never run for them.
    await prisma.waitlistEntry.create({
      data: { classId: fullClassId, studentId: noopId, position: 9, status: 'waiting' },
    });
    expect(await link(noopId)).toBeNull();

    const entry = await addToWaitlist(prisma, fullClassId, noopId);
    // Position 9 survives: this is the no-op exit, not the reactivation one,
    // which would move the row to the back of the queue.
    expect(entry.position).toBe(9);
    expect(entry.status).toBe('waiting');

    expect(await link(noopId)).not.toBeNull();
    expect((await invitationOf(noopId)).status).toBe('accepted');
  });

  it('a join the guards refuse writes no link and touches no invitation', async () => {
    // The guarantee here is the `db.$transaction` wrapper, NOT the fact that
    // the three guards happen to sit above the link write. Moving the write
    // above all three leaves this test — and the other 32 in the file — green,
    // because a guard throw rolls the writes back either way (M4, #166
    // re-review). What this test rules out is a refused join leaving the pair
    // connected; the test below is the one that can tell where that comes
    // from.
    await expect(addToWaitlist(prisma, notFullClassId, guardId)).rejects.toMatchObject({
      reason: 'class_not_full',
    });

    expect(await link(guardId)).toBeNull();
    const invitation = await invitationOf(guardId);
    expect(invitation.status).toBe('pending');
    expect(invitation.respondedAt).toBeNull();
  });

  it('a failure AFTER the link write rolls the link back too', async () => {
    // The test above cannot distinguish the transaction from the ordering,
    // because every guard it can trip fires before the first write. This one
    // fails at the last write instead, which only the transaction can undo:
    // by then the link and the invitation resolution are already issued.
    //
    // Injected rather than provoked, because nothing reachable throws there —
    // no unique key covers `(classId, position)` and the class row is locked
    // for the duration. A mid-transaction database error is the realistic
    // shape (a deadlock, a dropped connection, a constraint a later migration
    // adds), and what it must not do is leave a student linked to a teacher
    // whose queue they never entered.
    expect(await link(rollbackId)).toBeNull();
    const boom = new Error('injected: the waitlist row write failed');
    const failing = prisma.$extends({
      query: {
        waitlistEntry: {
          create() {
            throw boom;
          },
        },
      },
    });

    // Cast for the same reason as `invitations.revive.test.ts`: an extended
    // client is missing `$on`, so it is not assignable to `PrismaClient`
    // despite every method being the real one.
    await expect(
      addToWaitlist(failing as unknown as PrismaClient, fullClassId, rollbackId),
    ).rejects.toBe(boom);

    expect(await link(rollbackId)).toBeNull();
    const invitation = await invitationOf(rollbackId);
    expect(invitation.status).toBe('pending');
    expect(invitation.respondedAt).toBeNull();
    expect(
      await prisma.waitlistEntry.findUnique({
        where: { classId_studentId: { classId: fullClassId, studentId: rollbackId } },
      }),
    ).toBeNull();
  });

  it('a promotion repairs a missing link but leaves the invitation as it stands', async () => {
    // Written by hand, because that is the only way to reach a promotion
    // with no link now that joining makes one — and it is exactly what a row
    // written before this change looks like. The upsert in `promoteNext` is
    // the backstop for those rows.
    await prisma.waitlistEntry.create({
      data: { classId: promoteClassId, studentId: promoteId, position: 1, status: 'waiting' },
    });
    await prisma.registration.update({
      where: { classId_studentId: { classId: promoteClassId, studentId: promoteFillerId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const promoted = await promoteNext(prisma, promoteClassId);
    expect(promoted).not.toBeNull();
    expect(promoted!.studentId).toBe(promoteId);

    // The backstop ran.
    expect(await link(promoteId)).not.toBeNull();

    // And resolved nothing. A promotion fires when the TEACHER cancels some
    // other registration, so letting it answer an invitation on the
    // student's behalf hands them the timing of an acceptance the student
    // never gave.
    const invitation = await invitationOf(promoteId);
    expect(invitation.status).toBe('pending');
    expect(invitation.respondedAt).toBeNull();
  });
});

// ===========================================================================
// removeFromWaitlist takes the class lock — #174
// ===========================================================================

describe('removeFromWaitlist takes the class lock (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let fillerId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const mail = `lock-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for removeFromWaitlist lock test',
        pageSlug: `lock-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Lock Studio',
        address: `${uniqueSuffix} Lock St`,
        city: 'Amsterdam',
        postcode: '7890LK',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
    });
    teacherRoomId = teacherRoom.id;

    // One spot, taken by a filler — full, so the waitlist will accept joins.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Lock Flow',
        date: new Date('2099-09-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        status: 'open',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    const filler = await prisma.student.create({
      data: {
        firstName: 'LockFiller',
        lastName: 'Test',
        email: `lock-filler-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    fillerId = filler.id;
    await prisma.registration.create({
      data: { classId, studentId: fillerId, status: 'registered', tierAtBooking: 3 },
    });

    // Three waiting students — position 2 gets removed mid-lock below, so
    // the reorder that follows has real work to do: position 3 moves to 2.
    // (An earlier version of this comment said "2 → 1", which describes no
    // move this fixture makes — position 1 is untouched, and 2 is the entry
    // being removed rather than one being renumbered.)
    for (let i = 1; i <= 3; i++) {
      const student = await prisma.student.create({
        data: {
          firstName: `LockStudent${i}`,
          lastName: 'Test',
          email: `lock-student-${i}-${uniqueSuffix}@test.local`,
          incomeTier: i + 1,
        },
      });
      studentIds.push(student.id);
      await addToWaitlist(prisma, classId, student.id);
    }
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.deleteMany({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { id: { in: [...studentIds, fillerId] } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
  });

  /**
   * Held for under the 2s `lock_timeout` this site now sets, so what this
   * observes is the wait and not the timeout.
   */
  it('waits for a class row another transaction holds before renumbering', async () => {
    let holderReleased = false;

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 900));
        holderReleased = true;
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    const removing = removeFromWaitlist(prisma, classId, studentIds[1]!).then(
      () => 'returned' as const,
    );
    const outcome = await Promise.race([
      removing,
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);

    expect(outcome).toBe('waiting');
    expect(holderReleased).toBe(false);

    await holder;
    expect(await removing).toBe('returned');

    // Not a lock-discriminating assertion on its own — nothing else is
    // renumbering this queue concurrently, so it would pass with the lock
    // removed too (confirmed: it still passes with `lockClassRow` commented
    // out and the two wait assertions above deleted). What the wait
    // assertions above prove is the serialization; this only confirms
    // `removeFromWaitlist` left the queue correctly renumbered once it ran.
    const remaining = await prisma.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });
    expect(remaining.map((e) => e.position)).toEqual([1, 2]);
  });

  /**
   * #174 four-specialist review, Important 6. `removeFromWaitlist` writes the
   * entry keyed on `(classId, studentId)`, and a concurrent
   * `deleteStudentAccount` (`gdpr.ts`) deletes every `WaitlistEntry` the
   * student holds — so the row can vanish between the route's own pre-read
   * and this write. Before #174 that surfaced as Prisma's `P2025`, which
   * `classifyApiError` had no branch for, so a student tapping "leave
   * waitlist" at the wrong moment got a bare 500 on a request whose whole
   * meaning was "make this entry go away". Since the whole-branch review of
   * #216/#182) the write is an `updateMany` scoped to `status: 'waiting'`
   * rather than a bare `update` on the unique key — see `removeFromWaitlist`'s
   * docblock — so a vanished row now surfaces the same way a row that exists
   * but is no longer `waiting` does: `count === 0`, no throw either way.
   *
   * The delete is interposed inside the `waitlistEntry.updateMany` hook
   * rather than issued before the call, so it lands after `removeFromWaitlist`
   * has already taken the class lock and decided to proceed — the actual
   * shape of the race, not a rearrangement of it that would also pass on
   * unfixed code.
   */
  it('reports NOT_FOUND when the entry is deleted after the lock but before the write', async () => {
    const victimId = studentIds[2]!;
    let hookCalls = 0;

    const racing = prisma.$extends({
      query: {
        waitlistEntry: {
          async updateMany({ args, query }) {
            // Shape-keyed, per the house rule: `removeFromWaitlist`'s own
            // write is the one keyed on a plain `(classId, studentId)` pair
            // scoped to `status: 'waiting'`. `closeQueueOnStart`'s `updateMany`
            // has no `studentId` in its `where`, and
            // `withdrawWaitingEntriesForTeacher`'s keys `classId` with
            // `{ in: [...] }`, not a bare string — neither shape matches here.
            const where = args.where as
              | { classId?: unknown; studentId?: unknown; status?: unknown }
              | undefined;
            if (
              typeof where?.classId !== 'string' ||
              typeof where?.studentId !== 'string' ||
              where.status !== 'waiting'
            ) {
              return query(args);
            }

            hookCalls += 1;
            await prisma.waitlistEntry.deleteMany({ where: { classId, studentId: victimId } });
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `removeFromWaitlist`'s `PrismaClient`-typed parameter even though
      // every method it calls here is the real one — same cast as the hooks
      // in `gdpr.test.ts` and `class-transitions.test.ts`.
    }) as unknown as PrismaClient;

    const result = await removeFromWaitlist(racing, classId, victimId);

    expect(hookCalls).toBe(1);
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });
});

describe('handleSpotFreed (DB)', () => {
  // One fixed class drives every instant, so nothing here reads the wall
  // clock. Same derivation as the `claimSpot (DB)` block above:
  //   class starts       2026-06-03 09:00 UTC  (teacher default timezone UTC)
  //   HOURS_24        →  deadline 2026-06-02 09:00 UTC
  //   cutoff = deadline − 1h        2026-06-02 08:00 UTC
  const IN_CLAIM_WINDOW = new Date('2026-06-02T08:30:00Z');

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let fillerId: string;
  const waiterIds: string[] = [];

  beforeAll(async () => {
    const mail = `spotfreed-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'SpotFreed',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for handleSpotFreed tests',
        pageSlug: `spotfreed-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'SpotFreed Studio',
        address: `${uniqueSuffix} SpotFreed St`,
        city: 'Amsterdam',
        postcode: '9012SF',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;

    const mk = async (label: string) =>
      (
        await prisma.student.create({
          data: {
            firstName: 'SpotFreed',
            lastName: label,
            email: `spotfreed-${label}-${uniqueSuffix}@test.local`,
            incomeTier: 3,
          },
        })
      ).id;
    fillerId = await mk('filler');
    waiterIds.push(await mk('waiter1'), await mk('waiter2'));

    // maxStudents: 1 plus one registration is the cheapest way to be full,
    // which is what `addToWaitlist` requires before it will accept anyone.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'SpotFreed Flow',
        date: new Date('2026-06-03'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      },
    });
    classId = cls.id;

    await prisma.registration.create({
      data: { classId, studentId: fillerId, tierAtBooking: 3 },
    });
    for (const waiterId of waiterIds) {
      await addToWaitlist(prisma, classId, waiterId);
    }
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { id: { in: [fillerId, ...waiterIds] } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
  });

  const countBroadcasts = () =>
    prisma.notification.count({ where: { relatedClassId: classId, type: 'spot_available' } });

  /**
   * #212. Both halves are one test on purpose: the second is the control that
   * makes the first mean something. Asserting only "no notifications on a full
   * class" would pass against a `handleSpotFreed` that had been broken to do
   * nothing at all, which is not the property under test.
   */
  it('stays silent when the class is already full, and broadcasts when it is not', async () => {
    // The class is full (maxStudents 1, filler still registered) and the clock
    // is inside the final-hour window — the exact state a refill leaves behind
    // when it commits between a cancel and this hook. Before the fix, this
    // branch read the queue and notified both waiters without ever counting.
    const whenFull = await handleSpotFreed(prisma, classId, IN_CLAIM_WINDOW);
    expect(whenFull).toEqual({ action: 'none' });
    expect(await countBroadcasts()).toBe(0);

    // Now free the seat. Same class, same queue, same instant — the only thing
    // that changed is that a seat exists.
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId: fillerId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const whenFree = await handleSpotFreed(prisma, classId, IN_CLAIM_WINDOW);
    expect(whenFree).toEqual({ action: 'broadcast', notified: 2 });
    expect(await countBroadcasts()).toBe(2);
  });

  /**
   * #212. The capacity guard above is proved by M4; the lock that makes it
   * MEAN anything was proved by nothing — deleting `lockClassRow` left every
   * test in `waitlist`/`capacity`/`gdpr` green. That is the branch's whole
   * argument (spec §2: an unlocked count moves the race rather than closing
   * it) sitting untested.
   *
   * **Two traps, and the second one caught the first version of this test.**
   *
   * 1. *The notification write blocks anyway.* Holding the row and calling the
   *    hook on a class with a FREE seat passes with `lockClassRow` deleted: a
   *    broadcast that reaches its `createMany` takes `FOR KEY SHARE` on the
   *    same `Class` row via `relatedClassId` (`docs/lock-order.md`, "the
   *    fourth path"), which conflicts with the holder's `FOR UPDATE`. It
   *    blocks either way and the wait proves only that Postgres works. So the
   *    class is re-filled first: the hook counts, returns, and writes nothing,
   *    leaving the lock as the only thing that can block it.
   *
   * 2. *A wall-clock verdict is not a proposition about locks.* The first
   *    version raced the hook against a 400 ms timer and asserted "did not
   *    finish". Under CPU load, with `lockClassRow` deleted, it reported a
   *    PASS in 4 of 5 runs — instrumented, the hook had not yet reached its
   *    `FOR UPDATE` when the verdict fired at 552 ms. Slowness manufactured
   *    the evidence. CI is 2-4 cores against the 10-core machine that measured
   *    that, so it is likelier there, not less.
   *
   * The fix for trap 2 is to assert an outcome slowness cannot produce. The
   * holder keeps the row for longer than `lockClassRow`'s own 2 s
   * `SET LOCAL lock_timeout`, so the hook must abort with **55P03** — a
   * SQLSTATE a busy machine does not invent, and that only asking for a held
   * lock can produce. Measured 5/5 detection under the same load that broke
   * the timer version.
   *
   * `released` guards the converse: had the holder finished early, the hook
   * would have taken the lock cleanly and this would be testing nothing.
   */
  it('takes the class row lock before it counts', async () => {
    // Re-fill the class the previous test emptied, so the hook short-circuits
    // on capacity and writes nothing — trap 1 above. This also restores the
    // fixture's own starting state, so the test passes run alone or in order.
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId: fillerId } },
      data: { status: 'registered', cancelledAt: null },
    });
    const broadcastsBefore = await countBroadcasts();

    let released = false;
    // A handshake, not a sleep: the previous version waited 150 ms and hoped
    // the holder had the row by then. Measured holder-acquisition latency
    // reached 486 ms under load and 428 ms even idle, so that assumption
    // failed loudly and at random.
    let signalHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        // Longer than the 2 s `lock_timeout` inside `lockClassRow`, so the
        // hook is guaranteed to hit the bound rather than eventually succeed.
        await new Promise((r) => setTimeout(r, 3_500));
        released = true;
      },
      { timeout: 20_000 },
    );
    await lockHeld;

    const outcome = await handleSpotFreed(prisma, classId, IN_CLAIM_WINDOW).then(
      (result) => ({ ok: true as const, result }),
      (err: unknown) => ({ ok: false as const, err: String(err) }),
    );

    // Without `lockClassRow` the hook never asks for the row, counts a full
    // class, and returns `{ action: 'none' }` — `ok: true`, and this fails.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.err).toMatch(/55P03|lock timeout/i);
    expect(released).toBe(false);

    await holder;

    // It wrote nothing on the way out, so the aborted broadcast cost the
    // waiting students nothing except the notice they never got.
    expect(await countBroadcasts()).toBe(broadcastsBefore);
  });
});
