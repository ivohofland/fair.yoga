import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  getWaitlistWindow,
  addToWaitlist,
  removeFromWaitlist,
  promoteNext,
  claimSpot,
  WaitlistJoinError,
  WaitlistPromotionError,
} from './waitlist';

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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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
      '09:00',
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

describe('addToWaitlist + removeFromWaitlist (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let notFullClassId: string;
  let draftClassId: string;
  const studentIds: string[] = [];
  const fillerIds: string[] = [];

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

    async function makeClass(status: 'open' | 'draft', maxStudents: number): Promise<string> {
      const cls = await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: 'Hatha',
          date: new Date('2099-06-01'),
          startTime: '09:00',
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
    // Clean up in dependency order
    const ids = [classId, notFullClassId, draftClassId];
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: ids } } });
    await prisma.registration.deleteMany({ where: { classId: { in: ids } } });
    await prisma.class.deleteMany({ where: { id: { in: ids } } });
    for (const sid of [...studentIds, ...fillerIds]) {
      await prisma.student.delete({ where: { id: sid } });
    }
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
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
        startTime: '18:00',
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
  let roomId: string;
  let teacherRoomId: string;
  let fillerId: string;
  let waiterId: string;
  let outsiderId: string;
  const classIds: string[] = [];

  /**
   * A full, open class with `waiter` on its waitlist — the state every claim
   * starts from. `maxStudents: 1` plus one registration is the cheapest way to
   * be full, which is what `addToWaitlist` requires before it will accept
   * anyone.
   */
  const makeFullClass = async (): Promise<string> => {
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Claim Flow',
        date: new Date('2026-06-01'),
        startTime: '09:00',
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
 * Every student address here carries uppercase, deliberately.
 * `Invitation.email` and `TeacherBlock.email` are stored lowercase by
 * construction; `Student.email` is stored exactly as typed. An all-lowercase
 * fixture would make `resolveInvitationOnLink`'s `.toLowerCase()`
 * indistinguishable from its absence, which is the shape of a test that
 * cannot fail (#166 F1).
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
  /** Student id → the lowercase form of that student's mixed-case address. */
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
   * A student whose stored address carries uppercase, plus (optionally) the
   * invitation this teacher sent them — written lowercase, the way
   * `inviteContact` writes it.
   */
  const makeStudent = async (
    label: string,
    invitation?: { status: 'pending' | 'declined'; blocked?: boolean },
  ): Promise<string> => {
    const email = `Join-${label}-${uniqueSuffix}@Test.Local`;
    const lower = email.toLowerCase();
    const student = await prisma.student.create({
      data: { firstName: 'Join', lastName: label, email, incomeTier: 3 },
      select: { id: true },
    });
    studentIds.push(student.id);
    emailOf.set(student.id, lower);
    if (invitation) {
      await prisma.invitation.create({
        data: {
          teacherId,
          email: lower,
          firstName: 'Join',
          lastName: label,
          status: invitation.status,
          respondedAt: invitation.status === 'declined' ? new Date() : null,
        },
      });
      if (invitation.blocked) {
        await prisma.teacherBlock.create({ data: { teacherId, email: lower } });
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
    const makeClass = async (label: string, maxStudents: number): Promise<string> => {
      const cls = await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: label,
          date: new Date('2099-08-01'),
          startTime: '10:00',
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
        startTime: '09:00',
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
    // the reorder that follows has real work to do (2 → 1).
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
});
