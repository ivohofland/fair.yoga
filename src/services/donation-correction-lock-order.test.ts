/**
 * @serial-tier lock-contention — the one case below holds a `Class` row
 * `FOR UPDATE` open on a second connection for 900ms while the code under test
 * parks on that row under `lockClassRow`'s 2s `lock_timeout`. It races the
 * claim against a 400ms timer to show it is still waiting, then relies on the
 * holder committing and the claim acquiring the row inside the same bound,
 * about 1.1s of room that a tier-mate's lock noise can eat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';
import { claimCorrectionInvitation } from './donations';

const prisma = createPrismaClient();
// Prefixed from this file's own name, so its fixtures cannot collide with a
// serial tier-mate's on a unique email or slug.
const uniqueSuffix = `donlock-${Date.now()}`;

describe('the correction claim under the Class row lock (DB, #912)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  const studentIds: string[] = [];
  let classCounter = 0;

  const makeClass = () => {
    classCounter += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Vinyasa',
      date: slotDate('2026-06-01', classCounter),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 75,
      roomCost: 35,
      minRate: 0,
      targetRate: 0,
      minStudents: 1,
      maxStudents: 12,
      status: 'in_progress',
      settingsLocked: true,
      pricingMode: 'donation',
    });
  };

  const register = async (classId: string, status: 'no_show') => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Giver',
        lastName: 'Lock',
        email: `giver-${studentIds.length}-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    const reg = await prisma.registration.create({
      data: { classId, studentId: student.id, status, tierAtBooking: 3 },
    });
    return reg.id;
  };

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'DonLock',
        lastName: 'Teacher',
        email: `donlock-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `donlock-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for the correction claim lock race',
        pageSlug: `donlock-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    const room = await prisma.room.create({
      data: {
        venueName: 'Donation Lock Studio',
        address: `${uniqueSuffix} Lock St`,
        city: 'Amsterdam',
        postcode: '5678CD',
        floor: '2',
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
  });

  afterAll(async () => {
    try {
      await prisma.notification.deleteMany({
        where: { OR: [{ relatedClass: { calendarEntry: { teacherId } } }, { recipientId: { in: studentIds } }] },
      });
      await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      for (const sid of studentIds) await prisma.student.delete({ where: { id: sid } });
      await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
      await prisma.room.delete({ where: { id: roomId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: accountId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('a correction that commits while completion holds the lock is invited once completion commits (#912)', async () => {
    const cls = await makeClass();
    const regId = await register(cls.id, 'no_show');

    // The interleaving the lock exists for: completion has locked the class
    // and run its claim (which skips the no_show) but has not committed when
    // the teacher's correction to `attended` commits.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        await tx.class.update({ where: { id: cls.id }, data: { status: 'completed' } });
        await new Promise((r) => setTimeout(r, 900));
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));

    await prisma.registration.update({ where: { id: regId }, data: { status: 'attended' } });
    const claimed = claimCorrectionInvitation(prisma, regId);
    const outcome = await Promise.race([
      claimed.then(() => 'returned' as const),
      new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
    ]);
    expect(outcome).toBe('waiting');

    await holder;
    // Without the lock the claim reads the class as still in_progress (the
    // holder has not committed), stamps nothing, and nobody ever invites.
    expect(await claimed).toBe('invited');
    expect((await prisma.registration.findUniqueOrThrow({ where: { id: regId } })).donationInvitedAt).not.toBeNull();
  });
});
