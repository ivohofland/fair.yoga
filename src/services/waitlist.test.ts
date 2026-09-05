import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import crypto from 'crypto';
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
  SpotFreedError,
} from './waitlist';
import { isTransientDbError } from '@/lib/api-errors';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import * as dbLocks from '@/lib/db-locks';
import { unlinkTeacher } from './invitations';

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
 * would build exactly that. `CalendarEntry.startTime` is `@db.Time` and would
 * refuse the row outright at the DB, which is a less useful failure here than
 * this guard's message naming the fixture counter that produced it. The two
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
  // `CalendarEntry_teacher_slot_excl`, whose RANGE overlap a `durationMinutes:
  // 1` fixture keeps down to that minute. Routed through the module-level
  // `slotTime`
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
    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime(slotTime(makeClassCounter)),
        // ONE MINUTE (#327): the slot constraint is a range overlap now, so a
        // fixture spaced a minute from the last must be a minute long. No
        // waitlist test reads the duration — the cancel-deadline window these
        // tests turn on is computed from the START.
        durationMinutes: 1,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents,
        status,
        settingsLocked: true,
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
    await prisma.waitlistEntry.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
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
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: closingClassId } } } });
    });

    it('returns 0 and writes nothing when there is no queue', async () => {
      const closingClassId = await makeClass('in_progress', 2);
      const closed = await prisma.$transaction((tx) => closeQueueOnStart(tx, closingClassId));
      expect(closed).toBe(0);
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: closingClassId } } } });
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
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: [mineClassId, theirsClassId] } } } } });
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: staleClassId } } } });
  });
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
    const cls = await createClassFixture(prisma, {
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
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
   * `CalendarEntry_teacher_slot_excl` across this describe's repeated calls
   * would shift every boundary those constants were pinned against. So every
   * call after the first gets its own teacher (defaultTimezone UTC, matching the
   * fixture teacher below, since claimSpot reads the deadline off
   * `cls.teacher.defaultTimezone`) instead — the constraint is scoped per
   * teacher, so a different owner keeps the same slot legal.
   * `teacherRoomId` is reused across those teachers deliberately: claimSpot
   * never reads it, and slot-constraints.test.ts already establishes that
   * Class.teacherRoomId need not belong to the entry's teacherId.
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

    const cls = await createClassFixture(prisma, {
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
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
    await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { cancelledAt: new Date() },
    });

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
    // enough to keep every create legal under
    // `CalendarEntry_teacher_slot_excl`, whose RANGE overlap a
    // `durationMinutes: 1` fixture keeps down to that minute.
    // Routed through the module-level `slotTime` at a `10:xx` offset
    // (`slotTime(60 + counter)`) rather than a raw `10:${counter}` literal.
    let makeClassCounter = 0;
    const makeClass = async (label: string, maxStudents: number): Promise<string> => {
      makeClassCounter += 1;
      const cls = await createClassFixture(prisma, {
          teacherId,
          teacherRoomId,
          classType: label,
          date: new Date('2099-08-01'),
          startTime: hhmmToTime(slotTime(60 + makeClassCounter)),
          // ONE MINUTE (#327) — see the block above.
          durationMinutes: 1,
          roomCost: 25,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents,
          status: 'open',
          settingsLocked: true,
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
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
    // written before this change looks like. The `linkTeacherStudent` call
    // in `promoteNext` is the backstop for those rows.
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
// removeFromWaitlist survives the entry vanishing mid-lock — #174
// ===========================================================================

describe('removeFromWaitlist when the entry vanishes mid-lock (DB)', () => {
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
    const cls = await createClassFixture(prisma, {
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

    // One waiting student — the interposed-delete race below only needs an
    // entry it can make vanish. This block used to also cover renumbering a
    // multi-student queue mid-lock, which needed three; that test
    // (`waits for a class row another transaction holds before
    // renumbering`) moved to `waitlist-lock-order.test.ts` (#459).
    const student = await prisma.student.create({
      data: {
        firstName: 'LockStudent',
        lastName: 'Test',
        email: `lock-student-${uniqueSuffix}@test.local`,
        incomeTier: 2,
      },
    });
    studentIds.push(student.id);
    await addToWaitlist(prisma, classId, student.id);
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
    await prisma.student.deleteMany({ where: { id: { in: [...studentIds, fillerId] } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
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
    const victimId = studentIds[0]!;
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
      // in `class-transitions.test.ts`.
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
  /** Before the cutoff, so `getWaitlistWindow` answers `auto_promote`. */
  const BEFORE_CLAIM_WINDOW = new Date('2026-06-01T09:00:00Z');

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
    const cls = await createClassFixture(prisma, {
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
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
   * Which loss occurred, which no caller could previously tell.
   *
   * On the auto-promote branch the loss is one specific student not holding a
   * seat they should. On the broadcast branch it is N waiting students never
   * told a seat is free. Before this the three callers logged one message that
   * was true on either branch and specific to neither.
   *
   * Runs here, right after `stays silent when the class is already full, and
   * broadcasts when it is not`, because it needs what that test leaves behind
   * — a free seat and both waiters still `waiting`. Every assertion here
   * rejects, so `handleSpotFreed`'s own transaction rolls back with no side
   * effect, and nothing later in this file re-fills the seat.
   */
  it('wraps an auto-promote failure with its branch', async () => {
    const boom = new Error('injected: promotion failed');
    const failing = prisma.$extends({
      query: { waitlistEntry: { findMany() { throw boom; } } },
    }) as unknown as PrismaClient;

    const err = await handleSpotFreed(failing, classId, BEFORE_CLAIM_WINDOW).catch((e) => e);

    expect(err).toBeInstanceOf(SpotFreedError);
    expect(err).toMatchObject({ classId, window: 'auto_promote', cause: boom });
  });

  it('wraps a broadcast failure with its branch', async () => {
    const boom = new Error('injected: notification write failed');
    const failing = prisma.$extends({
      query: { notification: { createMany() { throw boom; } } },
    }) as unknown as PrismaClient;

    const err = await handleSpotFreed(failing, classId, IN_CLAIM_WINDOW).catch((e) => e);

    expect(err).toBeInstanceOf(SpotFreedError);
    expect(err).toMatchObject({ classId, window: 'first_come_first_claimed', cause: boom });
  });

  /**
   * The opening `class.findUnique` runs before the window resolves, so a failure
   * there has no branch to name. `null` is the honest answer and its own
   * diagnostic, not a missing value.
   */
  it('wraps a pre-window failure with a null branch', async () => {
    const boom = new Error('injected: class read failed');
    const failing = prisma.$extends({
      query: { class: { findUnique() { throw boom; } } },
    }) as unknown as PrismaClient;

    const err = await handleSpotFreed(failing, classId, IN_CLAIM_WINDOW).catch((e) => e);

    expect(err).toBeInstanceOf(SpotFreedError);
    expect(err).toMatchObject({ classId, window: null, cause: boom });
  });

  /**
   * The seam with `isTransientDbError` (`lib/api-errors.ts`), asserted here
   * because this is where both halves exist. Wrapping moves the real failure out
   * of `instanceof` range; if the matcher stopped seeing it, every routine pool
   * timeout on these paths would log at `error` and — in the reconciliation
   * sweep — redden `/api/health` on the spot.
   */
  it('stays classifiable as transient through the wrapper', async () => {
    const pool = new Prisma.PrismaClientKnownRequestError('pool timeout', {
      code: 'P2024',
      clientVersion: Prisma.prismaVersion.client,
    });
    const failing = prisma.$extends({
      query: { class: { findUnique() { throw pool; } } },
    }) as unknown as PrismaClient;

    const err = await handleSpotFreed(failing, classId, IN_CLAIM_WINDOW).catch((e) => e);

    expect(isTransientDbError(err)).toBe(true);
  });
});

/**
 * TWO DECOYS, because this predicate has two owner conjuncts and they fail
 * differently.
 *
 * `classT2` — student S waiting on ANOTHER TEACHER's class — is the
 * data-observable one: the `updateMany` this pre-lock brackets is keyed on the
 * returned ids and on `studentId`, so dropping `e."teacherId"` withdraws a
 * standing request S made of a teacher they never unlinked from.
 *
 * `classT3` — ANOTHER STUDENT waiting on T's class — is not data-observable at
 * all, because that same `updateMany` re-scopes on `studentId`. Dropping
 * `w."studentId"` widens the lock set and writes nothing extra, so the lock-set
 * assertion is the only thing that can witness it. That asymmetry is why this
 * test asserts the ids at all rather than only the surviving rows.
 *
 * In this test, dropping EITHER conjunct is caught by the `lockSets[0]`
 * equality assertion first — the decoys' own assertions pin what the write
 * predicate does, not which conjunct went missing.
 */
describe('withdrawWaitingEntriesForTeacher locks only the pair it was given (#453)', () => {
  // Random half as well as the clock, matching the sibling decoy fixture in
  // `gdpr.test.ts`: every unique column this fixture writes — the page slugs
  // and the email addresses — is keyed off this suffix, so two runs starting
  // in the same millisecond would collide in `beforeAll` rather than in an
  // assertion.
  const scopeSuffix = `wl-scope-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherTId: string;
  let teacherTAccountId: string;
  let teacherT2Id: string;
  let teacherT2AccountId: string;
  let scopeRoomId: string;
  let studentSId: string;
  let studentSAccountId: string;
  let studentSEmail: string;
  let studentS2Id: string;
  let classTId: string;
  let classT2Id: string;
  let classT3Id: string;

  beforeAll(async () => {
    const teacherT = await prisma.teacher.create({
      data: {
        firstName: 'Unlink',
        lastName: 'Teacher',
        email: `${scopeSuffix}-t@test.local`,
        account: { create: { email: `${scopeSuffix}-t@test.local` } },
        bio: 'Unlink scope fixture',
        pageSlug: `${scopeSuffix}-t`,
      },
      select: { id: true, accountId: true },
    });
    teacherTId = teacherT.id;
    teacherTAccountId = teacherT.accountId;

    const teacherT2 = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `${scopeSuffix}-t2@test.local`,
        account: { create: { email: `${scopeSuffix}-t2@test.local` } },
        bio: 'Unlink scope decoy',
        pageSlug: `${scopeSuffix}-t2`,
      },
      select: { id: true, accountId: true },
    });
    teacherT2Id = teacherT2.id;
    teacherT2AccountId = teacherT2.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Unlink Studio',
        address: `${scopeSuffix} St`,
        city: 'Amsterdam',
        postcode: '1234UL',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherTId,
      },
      select: { id: true },
    });
    scopeRoomId = room.id;

    const roomT = await prisma.teacherRoom.create({
      data: { teacherId: teacherTId, roomId: scopeRoomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });
    const roomT2 = await prisma.teacherRoom.create({
      data: { teacherId: teacherT2Id, roomId: scopeRoomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      classType: 'Unlink scope class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };

    // T's class that S waits in — the ONLY row the correct predicate matches.
    const classT = await createClassFixture(prisma, {
      ...base,
      teacherId: teacherTId,
      teacherRoomId: roomT.id,
      date: new Date('2099-07-01'),
    });
    classTId = classT.id;

    // Decoy 1: ANOTHER teacher's class, same student waiting.
    const classT2 = await createClassFixture(prisma, {
      ...base,
      teacherId: teacherT2Id,
      teacherRoomId: roomT2.id,
      date: new Date('2099-07-01'),
    });
    classT2Id = classT2.id;

    // Decoy 2: T's class again, a DIFFERENT student waiting. A different date
    // from `classT`, so the two live entries of one teacher cannot overlap.
    const classT3 = await createClassFixture(prisma, {
      ...base,
      teacherId: teacherTId,
      teacherRoomId: roomT.id,
      date: new Date('2099-07-02'),
    });
    classT3Id = classT3.id;

    studentSEmail = `${scopeSuffix}-s@test.local`;
    const studentS = await prisma.student.create({
      data: {
        firstName: 'Unlink',
        lastName: 'Student',
        email: studentSEmail,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: studentSEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentSId = studentS.id;
    studentSAccountId = studentS.accountId!;

    const studentS2 = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `${scopeSuffix}-s2@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    studentS2Id = studentS2.id;

    // Without this link `unlinkTeacher` returns NOT_LINKED before the pre-lock
    // runs at all — which the `toHaveLength(1)` assertion below is what catches.
    await prisma.teacherStudent.create({ data: { teacherId: teacherTId, studentId: studentSId } });

    await prisma.waitlistEntry.createMany({
      data: [
        { classId: classTId, studentId: studentSId, position: 1, status: 'waiting' },
        { classId: classT2Id, studentId: studentSId, position: 1, status: 'waiting' },
        { classId: classT3Id, studentId: studentS2Id, position: 1, status: 'waiting' },
      ],
    });
  });

  afterAll(async () => {
    const studentIds = [studentSId, studentS2Id];
    const teacherIds = [teacherTId, teacherT2Id];
    await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.room.deleteMany({ where: { id: scopeRoomId } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherTAccountId, teacherT2AccountId, studentSAccountId] } },
    });
    await prisma.$disconnect();
  });

  /**
   * The ids the pre-lock ACTUALLY held, read off the helper rather than
   * re-derived from a fixture. Calls through, so `unlinkTeacher`'s withdrawal
   * runs for real. Same idiom used at this issue's other call sites — see
   * `docs/superpowers/specs/2026-09-05-pre-lock-scope-decoys-design.md`
   * ("B. `waitlist.ts` — `withdrawWaitingEntriesForTeacher`", and "Why a text
   * assertion is not enough" for the instrument this one was chosen over) —
   * copied per file rather than shared, since each site's fixture is
   * independent.
   */
  const captureLockSets = (): string[][] => {
    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());
    return lockSets;
  };

  it('withdraws only this pair’s entries, and locks only their classes', async () => {
    const lockSets = captureLockSets();

    const result = await unlinkTeacher(prisma, {
      teacherId: teacherTId,
      studentId: studentSId,
      accountEmail: studentSEmail,
    });

    // NOT_LINKED here would mean the pre-lock never ran and every assertion
    // below is about a call that did nothing.
    expect(result).toEqual({ ok: true });

    expect(lockSets).toHaveLength(1);
    expect(lockSets[0]).toEqual([classTId]);

    // The call did its job: S's standing request of T is withdrawn.
    const withdrawn = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classTId, studentId: studentSId },
    });
    expect(withdrawn.status).toBe('removed');

    // DECOY 1. Dropping `e."teacherId"` makes `lockSets[0]` include
    // `classT2Id`, so the strict-equality assertion above throws first and
    // this line is not what the run reaches under that mutation — though the
    // row itself does flip to `removed` there, since the `updateMany` takes
    // its `classId` set from the lock. What this line guards on its own is
    // that write keeping the set it was given: lose `classId: { in: classIds }`
    // and a bystander teacher's queue is withdrawn behind a correct lock set.
    const otherTeachersQueue = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classT2Id, studentId: studentSId },
    });
    expect(otherTeachersQueue.status).toBe('waiting');

    // DECOY 2 — another student's request in T's own class. The ROW is
    // load-bearing: drop `w."studentId"` from the pre-lock and `classT3Id`
    // joins the array the assertion above pins. THIS LINE is a consistency
    // check on that row, not a guard on any reachable regression — no
    // single-fault mutation of the write can make it fail. The `updateMany`
    // re-scopes on `studentId`, so a widened pre-lock writes nothing extra;
    // and dropping the `updateMany`'s own `classId` set reaches decoy 1
    // instead, since `classT3` is not in the lock set.
    const otherStudentsRequest = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classT3Id, studentId: studentS2Id },
    });
    expect(otherStudentsRequest.status).toBe('waiting');
  });
});
