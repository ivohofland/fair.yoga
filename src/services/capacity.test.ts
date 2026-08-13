import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { readSeatCount } from './capacity';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('readSeatCount (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const mail = `capacity-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Capacity',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for readSeatCount tests',
        pageSlug: `capacity-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Capacity Studio',
        address: `${uniqueSuffix} Capacity St`,
        city: 'Amsterdam',
        postcode: '9012CP',
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

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Capacity Flow',
        date: new Date('2026-06-02'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 2,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      },
    });
    classId = cls.id;

    for (const label of ['a', 'b', 'c', 'd']) {
      const student = await prisma.student.create({
        data: {
          firstName: 'Capacity',
          lastName: label,
          email: `capacity-${label}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
      });
      studentIds.push(student.id);
    }
  });

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /** The four phases run in order against one class, each adding to the last. */
  it('counts only seat-occupying registrations, and reports overbooking honestly', async () => {
    // Phase 1 — empty class: every seat free.
    const empty = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(empty).toEqual({ maxStudents: 2, activeCount: 0, freeSeats: 2 });

    // Phase 2 — one registered: one seat left.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, tierAtBooking: 3 },
    });
    const partial = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(partial).toEqual({ maxStudents: 2, activeCount: 1, freeSeats: 1 });

    // Phase 3 — the two statuses that freed their seat must not count. A
    // `late_cancel` is still BILLED (it is in `CHARGED_STATUSES`) but its seat
    // is sold, so counting it here would make a full class look empty. This is
    // the phase that fails if the wrong status list is used.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[1]!, tierAtBooking: 3, status: 'cancelled' },
    });
    await prisma.registration.create({
      data: { classId, studentId: studentIds[2]!, tierAtBooking: 3, status: 'late_cancel' },
    });
    const withFreed = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(withFreed).toEqual({ maxStudents: 2, activeCount: 1, freeSeats: 1 });

    // Phase 4 — overbooked. Walk-ins may exceed maxStudents by design
    // (`registrations/route.ts`), so `freeSeats` goes NEGATIVE rather than
    // clamping at zero: how overbooked a class is, is real information, and
    // all four callers test `<= 0`.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[3]!, tierAtBooking: 3 },
    });
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
      data: { status: 'registered' },
    });
    const over = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(over).toEqual({ maxStudents: 2, activeCount: 3, freeSeats: -1 });
  });
});
