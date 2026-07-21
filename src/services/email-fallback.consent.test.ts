import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { processEmailFallback } from './email-fallback';

// The dry-run tests in email-fallback.test.ts can't tell "emailed" from
// "skipped and marked" — both end in emailSent=true. This file makes the
// send itself observable by mocking the Resend SDK, so the consent wiring
// (shouldEmailStudent) is pinned against both mutation directions.

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const studentEmail = `consent-student-${uniqueSuffix}@test.local`;

function sendsTo(email: string): number {
  return sendMock.mock.calls.filter(([args]) => args.to === email).length;
}

describe('processEmailFallback consent wiring (mocked send)', () => {
  let teacherId: string;
  let optedOutStudentId: string;
  let roomId: string;
  let soonClassId: string;
  const notificationIds: string[] = [];

  const savedApiKey = process.env.RESEND_API_KEY;
  const savedDryRun = process.env.EMAIL_DRY_RUN;

  async function makeNotification(overrides: {
    createdAt: Date;
    type: 'announcement' | 'class_cancelled';
    relatedClassId?: string;
  }) {
    const n = await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: optedOutStudentId,
        type: overrides.type,
        title: 'Consent test',
        body: 'Consent test body',
        isRead: false,
        emailSent: false,
        createdAt: overrides.createdAt,
        relatedClassId: overrides.relatedClassId ?? null,
      },
    });
    notificationIds.push(n.id);
    return n;
  }

  beforeAll(async () => {
    // Force the real-send path: a key is configured and dry-run is off.
    process.env.RESEND_API_KEY = 're_test_dummy';
    delete process.env.EMAIL_DRY_RUN;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Consent',
        lastName: 'Teacher',
        email: `consent-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `consent-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Consent wiring tests',
        pageSlug: `consent-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Consent',
        lastName: 'Student',
        email: studentEmail,
        emailNotifications: false,
      },
    });
    optedOutStudentId = student.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Consent Studio',
        address: `${uniqueSuffix} Consent St`,
        city: 'Amsterdam',
        postcode: '1111CO',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    const start = new Date(Date.now() + 60 * 60 * 1000);
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Vinyasa',
        date: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())),
        startTime: `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`,
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      },
    });
    soonClassId = cls.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    if (soonClassId) await prisma.class.delete({ where: { id: soonClassId } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    await prisma.student.delete({ where: { id: optedOutStudentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();

    if (savedApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedApiKey;
    if (savedDryRun === undefined) delete process.env.EMAIL_DRY_RUN;
    else process.env.EMAIL_DRY_RUN = savedDryRun;
  });

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ error: null });
  });

  it('sends the email for an essential type despite the opt-out', async () => {
    const essential = await makeNotification({
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
      type: 'class_cancelled',
    });

    await processEmailFallback(prisma);

    expect(sendsTo(studentEmail)).toBe(1);
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: essential.id } });
    expect(after.emailSent).toBe(true);
  });

  it('does not send for an optional type when opted out', async () => {
    const optional = await makeNotification({
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
      type: 'announcement',
    });

    await processEmailFallback(prisma);

    expect(sendsTo(studentEmail)).toBe(0);
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: optional.id } });
    expect(after.emailSent).toBe(true);
  });

  it('urgency never overrides consent: urgent optional stays unsent for an opted-out student', async () => {
    const urgentOptional = await makeNotification({
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      type: 'announcement',
      relatedClassId: soonClassId,
    });

    await processEmailFallback(prisma);

    expect(sendsTo(studentEmail)).toBe(0);
    // Eligible via the urgent window, skipped by consent — and marked so
    // the sweep doesn't reconsider it forever.
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: urgentOptional.id } });
    expect(after.emailSent).toBe(true);
  });

  it('surfaces send failures instead of reporting a healthy run', async () => {
    sendMock.mockImplementation((args: { to: string }) =>
      args.to === studentEmail
        ? Promise.resolve({ error: { message: 'boom' } })
        : Promise.resolve({ error: null }),
    );
    const failing = await makeNotification({
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
      type: 'class_cancelled',
    });

    await expect(processEmailFallback(prisma)).rejects.toThrow(/failed/);

    // Unmarked, so the next sweep retries it.
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: failing.id } });
    expect(after.emailSent).toBe(false);
  });
});
