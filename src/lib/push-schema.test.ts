import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const accountIds: string[] = [];
const teacherIds: string[] = [];

afterAll(async () => {
  if (teacherIds.length > 0) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  if (accountIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

describe('web push schema', () => {
  it('defaults a new student to the time-critical push groups only', async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Push', lastName: 'Defaults', email: `push-schema-${suffix}@test.local`,
        incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: `push-schema-${suffix}@test.local` } },
      },
    });
    accountIds.push(student.accountId!);
    expect({
      pushWaitlist: student.pushWaitlist,
      pushClassChanges: student.pushClassChanges,
      pushPayments: student.pushPayments,
      pushClassReminders: student.pushClassReminders,
      pushAnnouncements: student.pushAnnouncements,
      pushInvitations: student.pushInvitations,
    }).toEqual({
      pushWaitlist: true, pushClassChanges: true, pushPayments: false,
      pushClassReminders: false, pushAnnouncements: false, pushInvitations: false,
    });
  });

  it('refuses a second subscription with the same endpoint', async () => {
    const accountId = accountIds[0]!;
    const endpoint = `https://push.invalid/${suffix}`;
    await prisma.pushSubscription.create({ data: { accountId, endpoint, p256dh: 'p', auth: 'a' } });
    await expect(
      prisma.pushSubscription.create({ data: { accountId, endpoint, p256dh: 'p', auth: 'a' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  describe('teacher push defaults', () => {
    const teacherEmail = `push-schema-teacher-${suffix}@test.local`;
    let teacherId: string;

    beforeAll(async () => {
      const teacher = await prisma.teacher.create({
        data: {
          firstName: 'Push',
          lastName: 'Teacher',
          email: teacherEmail,
          account: { create: { email: teacherEmail } },
          bio: 'Push schema tests',
          pageSlug: `push-schema-teacher-${suffix}`,
        },
      });
      teacherId = teacher.id;
      teacherIds.push(teacherId);
      accountIds.push(teacher.accountId);
    });

    it('defaults a new teacher to the time-critical push group only', async () => {
      const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
      expect({
        pushAutoCancelled: teacher.pushAutoCancelled,
        pushBookings: teacher.pushBookings,
        pushClassCompleted: teacher.pushClassCompleted,
        pushClassReminders: teacher.pushClassReminders,
        pushInvitations: teacher.pushInvitations,
      }).toEqual({
        pushAutoCancelled: true, pushBookings: false, pushClassCompleted: false,
        pushClassReminders: false, pushInvitations: false,
      });
    });
  });
});
