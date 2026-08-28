/**
 * `completeClass`'s tier guard, in a file of its own for a reason that is not
 * about what it tests.
 *
 * The case below drops a CHECK constraint off `Registration` with raw DDL and
 * re-adds it in a `finally`. `ALTER TABLE` takes ACCESS EXCLUSIVE, which
 * conflicts with EVERY concurrent reader and writer of that table — and
 * `Registration` is touched all over the parallel `unit` tier. The test's own
 * work is ~100ms; what it spends the rest of its budget on is waiting to
 * acquire that lock, and it both suffers the queue and creates one.
 *
 * Measured: it fails on CI intermittently on `main` and failed 4 runs out of 4
 * on issue 272's branch, always as `Test timed out in 5000ms` — the branch's
 * mirror foreign keys take row locks no application code asks for, and that is
 * enough to turn an occasional loss into a certain one. Splitting the file is
 * what lets `LOCK_CONTENTION_TESTS` (`vitest.config.ts`) hold it without
 * serialising the other 81 cases in `class-lifecycle.test.ts`, which have no
 * DDL in them and are fine in parallel.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { completeClass } from './class-lifecycle';
import { createClassFixture } from '../../tests/class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

// Its own client, as `class-lifecycle.test.ts` has its own: this file was split
// out of that one and the module-level declaration stayed behind with the 81
// cases that remain there.
const prisma = new PrismaClient();
// PREFIXED, not just timestamped. This file and `class-lifecycle.test.ts` share
// one test database and both mint fixtures from a clock value; a bare
// `Date.now()` in each could collide on a unique email or slug. The prefix
// makes the two namespaces disjoint by construction rather than by luck.
const uniqueSuffix = `tierguard-${Date.now()}`;

describe('completeClass — billing path throws rather than mis-charging a bypassed tier', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let classId: string;
  let registrationId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'BadTier',
        lastName: 'Teacher',
        email: `bad-tier-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `bad-tier-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for the bypassed-constraint billing test',
        pageSlug: `bad-tier-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Bad Tier Studio',
        address: `${uniqueSuffix} Bad Tier St`,
        city: 'Amsterdam',
        postcode: '1357BT',
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
    teacherRoomId = teacherRoom.id;

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Bad Tier Flow',
        date: new Date('2026-06-01'),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'in_progress',
        settingsLocked: true,
      });
    classId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Bad',
        lastName: 'Tier',
        email: `bad-tier-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;

    const registration = await prisma.registration.create({
      data: { classId, studentId, status: 'registered', tierAtBooking: 3 },
    });
    registrationId = registration.id;
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registration: { classId } } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('rejects and rolls back a class completion when a registration carries a tier outside 1-5', async () => {
    // This engineers a state the type system AND the database's CHECK
    // constraint both say is impossible: `tierAtBooking` outside 1-5. It can
    // only be reached here by dropping the constraint out from under Prisma
    // with raw SQL. That is deliberate — this test is the only thing standing
    // between a one-word edit (reverting `completeClass`'s
    // `toIncomeTierOrThrow` call to `toIncomeTier`) and a silent mis-charge:
    // without it, completeClass would degrade the bad tier to
    // DEFAULT_INCOME_TIER and bill the student at the wrong price with
    // nothing anywhere to fail.
    //
    // The constraint drop must be committed before completeClass runs its own
    // transaction: completeClass opens its own `db.$transaction`, so a drop
    // issued inside some other interactive transaction here would not be
    // visible to it. Issuing it directly against `prisma` (no wrapping
    // transaction) commits it immediately.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Registration" DROP CONSTRAINT "Registration_tier_at_booking_check"`,
    );
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Registration" SET "tierAtBooking" = 0 WHERE id = $1`,
        registrationId,
      );

      await expect(
        completeClass(prisma, classId, { finishedEarly: true }),
      ).rejects.toThrow(/outside 1-5/);

      // The transaction rolled back — the class must not have completed.
      const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
      expect(cls.status).not.toBe('completed');
    } finally {
      // Restoring here, rather than after the assertions above, means a
      // failure in those assertions still leaves the database with its
      // constraint intact for every other test that depends on it.
      await prisma.$executeRawUnsafe(
        `UPDATE "Registration" SET "tierAtBooking" = 3 WHERE id = $1`,
        registrationId,
      );
      // Copied verbatim from
      // prisma/migrations/20260802150845_income_tier_range_check/migration.sql
      // rather than retyped, so a restored constraint can never drift from
      // the one the migration actually defines.
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "Registration" ADD CONSTRAINT "Registration_tier_at_booking_check"
  CHECK ("tierAtBooking" BETWEEN 1 AND 5)`,
      );
    }
  });
});
