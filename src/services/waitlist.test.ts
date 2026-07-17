import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  getWaitlistWindow,
  addToWaitlist,
  removeFromWaitlist,
  promoteNext,
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
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Waitlist',
        lastName: 'Teacher',
        email: `waitlist-teacher-${uniqueSuffix}@test.local`,
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

    // Create a class with status 'open' (waitlist scenario — full is derived from count)
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
        settingsLocked: true,
      },
    });
    classId = cls.id;

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
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    for (const sid of studentIds) {
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
});

describe('promoteNext (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Promote',
        lastName: 'Teacher',
        email: `promote-teacher-${uniqueSuffix}@test.local`,
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

    // Create a class with status 'open' (full is derived)
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Yin',
        date: new Date('2026-07-01'),
        startTime: '18:00',
        durationMinutes: 75,
        roomCost: 40,
        minRate: 10,
        targetRate: 20,
        minStudents: 3,
        maxStudents: 10,
        status: 'open',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    // Create 2 students
    for (let i = 1; i <= 2; i++) {
      const student = await prisma.student.create({
        data: {
          firstName: `PromoteStudent${i}`,
          lastName: 'Test',
          email: `promote-student-${i}-${uniqueSuffix}@test.local`,
          incomeTier: i + 1, // tiers 2, 3
        },
      });
      studentIds.push(student.id);
    }

    // Add both students to the waitlist
    await addToWaitlist(prisma, classId, studentIds[0]!);
    await addToWaitlist(prisma, classId, studentIds[1]!);
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    for (const sid of studentIds) {
      await prisma.student.delete({ where: { id: sid } });
    }
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('promotes the first waiting student and creates a registration', async () => {
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

  it('promotes the second student when called again', async () => {
    const promoted = await promoteNext(prisma, classId);
    expect(promoted).not.toBeNull();
    expect(promoted!.studentId).toBe(studentIds[1]);
    expect(promoted!.status).toBe('promoted');
  });

  it('returns null when no waiting students remain', async () => {
    const result = await promoteNext(prisma, classId);
    expect(result).toBeNull();
  });
});
