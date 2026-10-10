import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { processEmailFallback } from './email-fallback';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import { log } from '@/lib/log';

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

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
  const extraStudentIds: string[] = [];

  const savedApiKey = process.env.RESEND_API_KEY;
  const savedLettermintToken = process.env.LETTERMINT_API_TOKEN;
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
    process.env.LETTERMINT_API_TOKEN = 'lm_test_dummy';
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
    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Vinyasa',
        date: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())),
        startTime: hhmmToTime(`${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      });
    soonClassId = cls.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    if (extraStudentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: extraStudentIds } } });
    }
    if (soonClassId) await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: soonClassId } } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    await prisma.student.delete({ where: { id: optedOutStudentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();

    if (savedApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedApiKey;
    if (savedLettermintToken === undefined) delete process.env.LETTERMINT_API_TOKEN;
    else process.env.LETTERMINT_API_TOKEN = savedLettermintToken;
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

  it('emails a walk-in notice to an unclaimed, opted-out student on the first sweep, and only once', async () => {
    // Its own recipient, so no other case's notification can add to its count.
    const email = `consent-walkin-${uniqueSuffix}@test.local`;
    const student = await prisma.student.create({
      data: { firstName: 'Walked', lastName: 'In', email, emailNotifications: false },
      select: { id: true, accountId: true, claimedAt: true },
    });
    extraStudentIds.push(student.id);
    expect(student).toMatchObject({ accountId: null, claimedAt: null });
    // Created just now and tied to no class, so neither the unread threshold
    // nor the urgent window makes it eligible: only its type does.
    const notice = await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: student.id,
        type: 'walk_in_added',
        title: "You're in Vinyasa",
        body: 'Consent Teacher added you to Vinyasa. Your price is calculated after class.',
        isRead: false,
        emailSent: false,
      },
    });
    notificationIds.push(notice.id);

    await processEmailFallback(prisma);

    expect(sendsTo(email)).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: notice.id } })).emailSent).toBe(true);

    await processEmailFallback(prisma);

    expect(sendsTo(email)).toBe(1);
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

describe('processEmailFallback — teacher preferences (#49)', () => {
  const sfx = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacherEmail = `prefs-teacher-${sfx}@test.local`;
  let teacherId: string;
  let dualStudentId: string;
  const ids: string[] = [];

  async function note(type: 'booking_confirmed' | 'class_cancelled' | 'payment_request' | 'teacher_invitation' | 'announcement') {
    const n = await prisma.notification.create({
      data: {
        recipientType: 'teacher', recipientId: teacherId, type,
        title: 'Prefs test', body: 'Prefs test body', isRead: false, emailSent: false,
        createdAt: new Date(Date.now() - 45 * 60 * 1000),
      },
    });
    ids.push(n.id);
    return n;
  }

  async function setPrefs(data: {
    bookingNotifications?: 'inbox_and_email' | 'inbox_only' | 'off';
    emailOnClassCompleted?: boolean;
    emailOnInvitation?: boolean;
  }) {
    await prisma.teacher.update({ where: { id: teacherId }, data });
  }

  beforeAll(async () => {
    process.env.RESEND_API_KEY = 're_test_dummy';
    process.env.LETTERMINT_API_TOKEN = 'lm_test_dummy';
    delete process.env.EMAIL_DRY_RUN;
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Prefs', lastName: 'Teacher', email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Teacher prefs tests', pageSlug: `prefs-teacher-${sfx}`, defaultTimezone: 'UTC',
      },
    });
    teacherId = t.id;
    // The same account wears a student hat that has opted out.
    const s = await prisma.student.create({
      data: { firstName: 'Prefs', lastName: 'Dual', email: teacherEmail, emailNotifications: false, accountId: t.accountId, claimedAt: new Date() },
    });
    dualStudentId = s.id;
  });

  afterAll(async () => {
    if (ids.length) await prisma.notification.deleteMany({ where: { id: { in: ids } } });
    if (dualStudentId) await prisma.student.delete({ where: { id: dualStudentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
  });

  beforeEach(async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ error: null });
    vi.mocked(log.error).mockClear();
    await setPrefs({ bookingNotifications: 'inbox_and_email', emailOnClassCompleted: true, emailOnInvitation: true });
  });

  it('emails every teacher type by default, despite the student hat having opted out', async () => {
    for (const t of ['booking_confirmed', 'payment_request', 'teacher_invitation'] as const) await note(t);
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(3);
  });

  it.each([
    ['booking_confirmed', { bookingNotifications: 'inbox_only' }],
    ['booking_confirmed', { bookingNotifications: 'off' }],
    ['payment_request', { emailOnClassCompleted: false }],
    ['teacher_invitation', { emailOnInvitation: false }],
  ] as const)('skips %s when %o, and marks it sent', async (type, prefs) => {
    const n = await note(type); // created first: the preference changes after the row exists
    await setPrefs(prefs);
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).emailSent).toBe(true);
  });

  it('always emails an auto-cancel, with every preference off', async () => {
    await setPrefs({ bookingNotifications: 'off', emailOnClassCompleted: false, emailOnInvitation: false });
    await note('class_cancelled');
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(1);
  });

  it('leaves the student hat to its own setting when every teacher preference is off', async () => {
    await setPrefs({ bookingNotifications: 'off', emailOnClassCompleted: false, emailOnInvitation: false });
    await prisma.student.update({ where: { id: dualStudentId }, data: { emailNotifications: true } });
    try {
      const n = await prisma.notification.create({
        data: {
          recipientType: 'student', recipientId: dualStudentId, type: 'announcement',
          title: 'Prefs test', body: 'Prefs test body', isRead: false, emailSent: false,
          createdAt: new Date(Date.now() - 45 * 60 * 1000),
        },
      });
      ids.push(n.id);
      await processEmailFallback(prisma);
      expect(sendsTo(teacherEmail)).toBe(1);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).emailSent).toBe(true);
    } finally {
      await prisma.student.update({ where: { id: dualStudentId }, data: { emailNotifications: false } });
    }
  });

  it('fails open on a teacher row outside TeacherNotificationType: emailed, and logged as an error', async () => {
    await setPrefs({ bookingNotifications: 'off', emailOnClassCompleted: false, emailOnInvitation: false });
    const n = await note('announcement'); // only reachable by a direct write — the typed path refuses it
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(1);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: n.id }),
      expect.any(String),
    );
  });

  it('reports a teacher row outside TeacherNotificationType as TEACHER_NOTIFICATION_TYPE_UNKNOWN', async () => {
    await setPrefs({ bookingNotifications: 'off', emailOnClassCompleted: false, emailOnInvitation: false });
    const n = await note('announcement');
    await processEmailFallback(prisma);
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'TEACHER_NOTIFICATION_TYPE_UNKNOWN', notificationId: n.id, type: 'announcement' }),
      'teacher notification outside TeacherNotificationType; emailed ignoring preferences',
    );
  });
});
