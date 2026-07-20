import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  autoTransitionToInProgress,
  autoCancelClasses,
  autoCompleteClasses,
} from './class-transitions';

// ===========================================================================
// Automated class transitions (DB) — timezone-aware lifecycle sweeps.
// The fixture teacher is in Europe/Amsterdam (UTC+2 in summer): a class
// stored as date 2026-07-20 / startTime "18:00" starts at 16:00Z.
// ===========================================================================

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-tz`;

describe('class transitions (DB, timezone-aware)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tz',
        lastName: 'Teacher',
        email: `tz-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `tz-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Timezone transition tests',
        pageSlug: `tz-teacher-${uniqueSuffix}`,
        defaultTimezone: 'Europe/Amsterdam',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Tz Studio',
        address: `${uniqueSuffix} Tz St`,
        city: 'Amsterdam',
        postcode: '1234TZ',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 35 },
    });
    teacherRoomId = teacherRoom.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Tz',
        lastName: 'Student',
        email: `tz-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: { in: [teacherId, studentId] } } });
    await prisma.payment.deleteMany({ where: { registration: { studentId } } });
    await prisma.registration.deleteMany({ where: { studentId } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  function makeClass(overrides: Record<string, unknown> = {}) {
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-07-20'),
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
        ...overrides,
      },
    });
  }

  it('auto-transitions once the LOCAL start time has passed (16:00Z for 18:00 Amsterdam)', async () => {
    const cls = await makeClass();

    // 16:30Z is after the local 18:00 CEST start (16:00Z) but before a
    // naive-UTC 18:00Z reading — the old UTC code would have skipped this.
    await autoTransitionToInProgress(prisma, new Date('2026-07-20T16:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('in_progress');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('does not transition before the local start time', async () => {
    const cls = await makeClass();

    await autoTransitionToInProgress(prisma, new Date('2026-07-20T15:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('open');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('catches early-local-morning classes that start before their UTC calendar date', async () => {
    // 00:30 Amsterdam on July 20 = 22:30Z on July 19 — earlier than the
    // stored date (July 20 00:00Z). The sweep's date prefilter must not
    // exclude it.
    const cls = await makeClass({ startTime: '00:30' });

    await autoTransitionToInProgress(prisma, new Date('2026-07-19T23:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('in_progress');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('auto-cancels below-minimum classes inside the local check window and notifies the teacher', async () => {
    // HOURS_2 check window before 16:00Z start = 14:00Z–16:00Z.
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2' });

    await autoCancelClasses(prisma, new Date('2026-07-20T15:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('cancelled');

    const teacherNote = await prisma.notification.findFirst({
      where: { recipientType: 'teacher', recipientId: teacherId, relatedClassId: cls.id },
    });
    expect(teacherNote).not.toBeNull();
    await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('does not auto-cancel before the local check window opens', async () => {
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2' });

    // 13:00Z is before the 14:00Z window opening.
    await autoCancelClasses(prisma, new Date('2026-07-20T13:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('open');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('auto-completes an in-progress class after its local end time', async () => {
    const cls = await makeClass({ status: 'in_progress', minStudents: 1 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
    });

    // Ends 17:00Z (16:00Z start + 60 min); 17:30Z is past that.
    await autoCompleteClasses(prisma, new Date('2026-07-20T17:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('completed');
    expect(updated.totalRevenue).not.toBeNull();
  });
});
