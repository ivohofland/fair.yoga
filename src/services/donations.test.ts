import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrismaClient, type RegistrationStatus } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate, slotTime } from '../../tests/class-fixtures';
import { completeClass } from './class-lifecycle';

const prisma = createPrismaClient();
const uniqueSuffix = `donations-${Date.now()}`;

describe('completeClass on a donation class (#912)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  const studentIds: string[] = [];
  let classCounter = 0;
  let studentCounter = 0;

  const makeClass = (extra: { pricingMode?: 'tiered' | 'donation'; minRate?: number; targetRate?: number } = {}) => {
    classCounter += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Vinyasa',
      date: slotDate('2026-06-01', classCounter),
      startTime: hhmmToTime(slotTime(540)),
      durationMinutes: 75,
      roomCost: 35,
      minRate: 0,
      targetRate: 0,
      minStudents: 1,
      maxStudents: 12,
      status: 'in_progress',
      settingsLocked: true,
      pricingMode: 'donation',
      ...extra,
    });
  };

  const seedStudent = async (i: number) => {
    const student = await prisma.student.create({
      data: {
        firstName: `Giver${i}`,
        lastName: 'Test',
        email: `giver-${i}-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    return student.id;
  };

  const register = async (
    classId: string,
    status: RegistrationStatus,
    extra: { isWalkIn?: boolean } = {},
  ) => {
    studentCounter += 1;
    const studentId = await seedStudent(studentCounter);
    const reg = await prisma.registration.create({
      data: { classId, studentId, status, tierAtBooking: 3, ...extra },
    });
    return { id: reg.id, studentId };
  };

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Donation',
        lastName: 'Teacher',
        email: `donation-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `donation-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for donation completion tests',
        pageSlug: `donation-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: {
        venueName: 'Donation Studio',
        address: `${uniqueSuffix} Donation St`,
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
    await prisma.notification.deleteMany({
      where: { OR: [{ relatedClass: { calendarEntry: { teacherId } } }, { recipientId: { in: [...studentIds, teacherId] } }] },
    });
    await prisma.payment.deleteMany({ where: { registration: { class: { calendarEntry: { teacherId } } } } });
    await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    for (const sid of studentIds) await prisma.student.delete({ where: { id: sid } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('writes no Payment, leaves the snapshot null and stamps exactly registered + attended (#912)', async () => {
    const cls = await makeClass();
    const regs = {
      registered: await register(cls.id, 'registered'),
      attended: await register(cls.id, 'attended'),
      walkIn: await register(cls.id, 'registered', { isWalkIn: true }),
      noShow: await register(cls.id, 'no_show'),
      lateCancel: await register(cls.id, 'late_cancel'),
      cancelled: await register(cls.id, 'cancelled'),
    };
    const result = await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    expect(result.ok).toBe(true);

    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
    const row = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(row.status).toBe('completed');
    expect(row.totalRevenue).toBeNull();
    expect(row.vatTotal).toBeNull();
    expect(row.effectiveTeacherRate).toBeNull();
    expect(row.donationTotal).toBeNull();
    expect(row.totalStudents).toBe(5); // the CHARGED_STATUSES count, as tiered completion writes it

    const stamped = await prisma.registration.findMany({
      where: { classId: cls.id, donationInvitedAt: { not: null } },
      select: { id: true },
    });
    expect(stamped.map((r) => r.id).sort()).toEqual(
      [regs.registered.id, regs.attended.id, regs.walkIn.id].sort(),
    );

    const invites = await prisma.notification.findMany({
      where: { relatedClassId: cls.id, type: 'donation_invitation' },
    });
    expect(invites.map((n) => n.recipientId).sort()).toEqual(
      [regs.registered.studentId, regs.attended.studentId, regs.walkIn.studentId].sort(),
    );
    for (const n of invites) {
      expect(n.body).not.toMatch(/€|\d+[.,]\d{2}|IBAN|NL\d{2}/);
    }

    const notice = await prisma.notification.findFirstOrThrow({
      where: { relatedClassId: cls.id, recipientType: 'teacher' },
    });
    expect(notice.body).toMatch(/is complete — 3 students invited to give\.$/);
    expect(await prisma.registration.count({ where: { classId: cls.id, price: { not: null } } })).toBe(0);
  });

  it('a donation class nobody came to completes with "No one to invite." (#912)', async () => {
    const cls = await makeClass();
    await register(cls.id, 'no_show');
    await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    const notice = await prisma.notification.findFirstOrThrow({
      where: { relatedClassId: cls.id, recipientType: 'teacher' },
    });
    expect(notice.body).toMatch(/is complete\. No one to invite\.$/);
  });

  it('never re-stamps a booking already invited (#912)', async () => {
    const cls = await makeClass();
    const { id: regId } = await register(cls.id, 'attended');
    // A value completion cannot produce: it stamps the transaction's own clock.
    const reserved = new Date('2000-01-01T00:00:00.000Z');
    await prisma.registration.update({ where: { id: regId }, data: { donationInvitedAt: reserved } });
    await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: regId } });
    expect(after.donationInvitedAt?.toISOString()).toBe(reserved.toISOString());
    expect(await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'donation_invitation' } })).toBe(0);
  });

  it('an erasure completion (finishedEarly) invites nobody (#912, Review Focus 2)', async () => {
    const cls = await makeClass();
    const { id: regId } = await register(cls.id, 'attended');
    await completeClass(prisma, cls.id, { finishedEarly: true });
    expect((await prisma.registration.findUniqueOrThrow({ where: { id: regId } })).donationInvitedAt).toBeNull();
    expect(await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'donation_invitation' } })).toBe(0);
  });

  it('a tiered class still bills as before and stamps nothing (#912)', async () => {
    const cls = await makeClass({ pricingMode: 'tiered', minRate: 15, targetRate: 25 });
    await register(cls.id, 'attended');
    await completeClass(prisma, cls.id, { sweepAt: new Date('2099-01-01T00:00:00Z') });
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(1);
    expect(await prisma.registration.count({ where: { classId: cls.id, donationInvitedAt: { not: null } } })).toBe(0);
  });
});
