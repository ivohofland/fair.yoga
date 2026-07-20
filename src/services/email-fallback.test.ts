import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { processEmailFallback } from './email-fallback';

// RESEND_API_KEY is unset in the test environment, so the service takes the
// dev path (logs instead of sending) — what we assert is the bookkeeping:
// which notifications get picked up and marked emailSent.

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('processEmailFallback (DB)', () => {
  let teacherId: string;
  let optedOutStudentId: string;
  const notificationIds: string[] = [];

  async function makeNotification(overrides: {
    recipientType: 'teacher' | 'student';
    recipientId: string;
    createdAt: Date;
    isRead?: boolean;
  }) {
    const n = await prisma.notification.create({
      data: {
        recipientType: overrides.recipientType,
        recipientId: overrides.recipientId,
        type: 'reminder',
        title: 'Fallback test',
        body: 'Fallback test body',
        isRead: overrides.isRead ?? false,
        emailSent: false,
        createdAt: overrides.createdAt,
      },
    });
    notificationIds.push(n.id);
    return n;
  }

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Fallback',
        lastName: 'Teacher',
        email: `fallback-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `fallback-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Email fallback tests',
        pageSlug: `fallback-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'OptedOut',
        lastName: 'Student',
        email: `fallback-student-${uniqueSuffix}@test.local`,
        emailNotifications: false,
      },
    });
    optedOutStudentId = student.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    await prisma.student.delete({ where: { id: optedOutStudentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('processes unread notifications older than 30 minutes and marks them sent', async () => {
    const old = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: old.id } });
    expect(after.emailSent).toBe(true);
  });

  it('leaves fresh notifications for the next run', async () => {
    const fresh = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(after.emailSent).toBe(false);
  });

  it('leaves read notifications alone', async () => {
    const read = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
      isRead: true,
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: read.id } });
    expect(after.emailSent).toBe(false);
  });

  it('marks opted-out students as handled without retrying forever', async () => {
    const optedOut = await makeNotification({
      recipientType: 'student',
      recipientId: optedOutStudentId,
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
    });

    await processEmailFallback(prisma);

    // emailNotifications=false: no email goes out, but the row must be
    // marked so the cron does not pick it up again every run.
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: optedOut.id } });
    expect(after.emailSent).toBe(true);
  });
});
