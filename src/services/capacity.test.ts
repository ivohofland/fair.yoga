import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { readSeatCount } from './capacity';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('readSeatCount (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let overClassId: string;
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

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Capacity Flow',
        date: new Date('2026-06-02'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 2,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      });
    classId = cls.id;

    // A SECOND class for the overbooked case, so that test needs nothing from
    // the one above and can be read (and run) alone. Same teacher and date is
    // legal because `Class_teacher_slot_unique` is on (teacherId, date,
    // startTime) — a different `startTime` is all it takes.
    const over = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Capacity Overbooked',
        date: new Date('2026-06-02'),
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 2,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      });
    overClassId = over.id;

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
    await prisma.registration.deleteMany({ where: { classId: { in: [classId, overClassId] } } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: [classId, overClassId] } } } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /** Three phases against one class, each adding to the last. */
  it('counts only seat-occupying registrations', async () => {
    // Phase 1 — empty class: every seat free.
    const empty = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(empty).toEqual({ maxStudents: 2, activeCount: 0, freeSeats: 2, isFull: false });

    // Phase 2 — one registered: one seat left.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, tierAtBooking: 3 },
    });
    const partial = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(partial).toEqual({ maxStudents: 2, activeCount: 1, freeSeats: 1, isFull: false });

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
    expect(withFreed).toEqual({ maxStudents: 2, activeCount: 1, freeSeats: 1, isFull: false });
  });

  /**
   * Its own `it()` and its own class, deliberately — this is the ONLY test in
   * the repository defending the "`freeSeats` is not clamped" contract, and it
   * was a fourth phase of the test above until PR #218's review. Two problems
   * with that. Applying `Math.max(0, …)` to `readSeatCount` fails this
   * assertion and nothing else in the suite, so it is load-bearing and alone;
   * and while it shared an `it()` with the phases above, a second defect
   * short-circuited the test before it ran, blending two mutations into one
   * reported diff that matched neither's log entry.
   *
   * The separate class means it also needs no state from its neighbour.
   */
  it('reports overbooking honestly rather than clamping at zero', async () => {
    // Walk-ins may exceed maxStudents by design (`registrations/route.ts`), so
    // `freeSeats` goes NEGATIVE. No caller reads the magnitude — every one of
    // the five reads `isFull` — so a clamp would change no behaviour at all
    // and destroy the only record of HOW overbooked a class is.
    for (const studentId of [studentIds[0]!, studentIds[1]!, studentIds[3]!]) {
      await prisma.registration.create({
        data: { classId: overClassId, studentId, tierAtBooking: 3 },
      });
    }
    const over = await prisma.$transaction((tx) => readSeatCount(tx, overClassId));
    expect(over).toEqual({ maxStudents: 2, activeCount: 3, freeSeats: -1, isFull: true });
  });
});
