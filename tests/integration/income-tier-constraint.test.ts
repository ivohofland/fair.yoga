import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();
const suffix = `tier-check-${Date.now()}`;
const studentIds: string[] = [];

afterAll(async () => {
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.$disconnect();
});

/**
 * These assert the DATABASE rejects the write, not that any TypeScript
 * guard does. `toIncomeTier` degrades rather than throwing precisely
 * because it trusts these constraints; if they are absent, that fallback
 * silently becomes load-bearing and nobody finds out.
 *
 * The `toThrow` calls assert the constraint's own name, not just that
 * *something* threw — a masking failure (a unique-email collision, an FK
 * violation from stale rows) would satisfy a bare `rejects.toThrow()` with
 * the constraint absent. The names are this repo's own identifiers, set in
 * the income_tier_range_check migration, not a Prisma internal, so they are
 * safe to assert on.
 */
describe('income tier range constraints', () => {
  it('rejects an out-of-range Student.incomeTier on create', async () => {
    await expect(
      prisma.student.create({
        data: {
          firstName: 'Out', lastName: 'OfRange',
          email: `out-of-range-${suffix}@test.local`,
          incomeTier: 0,
        },
      }),
    ).rejects.toThrow(/Student_income_tier_check/);
  });

  it('rejects an out-of-range Student.incomeTier on update', async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'In', lastName: 'Range',
        email: `in-range-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);

    await expect(
      prisma.student.update({ where: { id: student.id }, data: { incomeTier: 6 } }),
    ).rejects.toThrow(/Student_income_tier_check/);

    // The row is untouched — a rejected write is not a partial write.
    const after = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.incomeTier).toBe(3);
  });

  it('accepts both boundaries', async () => {
    for (const tier of [1, 5]) {
      const student = await prisma.student.create({
        data: {
          firstName: 'Edge', lastName: `T${tier}`,
          email: `edge-${tier}-${suffix}@test.local`,
          incomeTier: tier,
        },
      });
      studentIds.push(student.id);
      expect(student.incomeTier).toBe(tier);
    }
  });
});

/**
 * `Registration.tierAtBooking` — not `Student.incomeTier` — is the column
 * that feeds the pricing engine, and the one the deleted per-student
 * `Invalid tier` throw used to guard. This is the more important of the two
 * constraints to cover with an automated test.
 */
describe('Registration.tierAtBooking constraint', () => {
  const regSuffix = `tier-check-reg-${Date.now()}`;
  let teacherId: string;
  let roomId: string;
  let studentId: string;
  let createStudentId: string;
  let classId: string;
  let registrationId: string;

  beforeAll(async () => {
    const teacherEmail = `tier-teacher-${regSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tier',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Teacher for the tierAtBooking constraint test',
        pageSlug: `tier-teacher-${regSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Tier Venue',
        address: `${regSuffix} Tier St`,
        city: 'Testville',
        postcode: '1234TC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    });

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Tier Check Flow',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'open',
      });
    classId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Booking',
        lastName: 'Student',
        email: `tier-reg-student-${regSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;

    const registration = await prisma.registration.create({
      data: { classId, studentId, tierAtBooking: 3, status: 'registered' },
    });
    registrationId = registration.id;

    // A second student so the create-side test below has a fresh
    // (classId, studentId) pair — reusing `studentId` would collide with the
    // @@unique([classId, studentId]) constraint and mask the CHECK violation
    // this test exists to prove.
    const createStudent = await prisma.student.create({
      data: {
        firstName: 'Create',
        lastName: 'Student',
        email: `tier-reg-create-student-${regSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    createStudentId = createStudent.id;
  });

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, createStudentId] } } });
    const t = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { email: true },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: t.email } });
  });

  it('rejects an out-of-range Registration.tierAtBooking on update', async () => {
    await expect(
      prisma.registration.update({
        where: { id: registrationId },
        data: { tierAtBooking: 0 },
      }),
    ).rejects.toThrow(/Registration_tier_at_booking_check/);

    // The row is untouched — a rejected write is not a partial write.
    const after = await prisma.registration.findUniqueOrThrow({
      where: { id: registrationId },
    });
    expect(after.tierAtBooking).toBe(3);
  });

  it('rejects an out-of-range Registration.tierAtBooking on create', async () => {
    // The existing coverage above is update-only; create is the path a bad
    // row would actually arrive through (the initial stamp at booking).
    await expect(
      prisma.registration.create({
        data: { classId, studentId: createStudentId, tierAtBooking: 0, status: 'registered' },
      }),
    ).rejects.toThrow(/Registration_tier_at_booking_check/);

    // The rejected create must not have left a row behind.
    const count = await prisma.registration.count({
      where: { classId, studentId: createStudentId },
    });
    expect(count).toBe(0);
  });
});
