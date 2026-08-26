import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { processEmailFallback } from './email-fallback';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

// RESEND_API_KEY is unset in the test environment, so the service takes the
// dev path (logs instead of sending) — what we assert is the bookkeeping:
// which notifications get picked up and marked emailSent.
//
// Except in the last describe, which forces the real-send path against this
// mocked SDK. Claim-before-send is only observable where a send actually
// happens: on the dry-run path the mark still follows the decision, so
// every ordering looks identical from the database alone.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const teacherEmail = `fallback-teacher-${uniqueSuffix}@test.local`;

function sendsTo(email: string): number {
  return sendMock.mock.calls.filter(([args]) => args.to === email).length;
}

describe('processEmailFallback (DB)', () => {
  let teacherId: string;
  let optedOutStudentId: string;
  let roomId: string;
  let soonClassId: string;
  let laterClassId: string;
  let amsTeacherId: string;
  let amsClassId: string;
  const notificationIds: string[] = [];
  const classIds: string[] = [];

  async function makeNotification(overrides: {
    recipientType: 'teacher' | 'student';
    recipientId: string;
    createdAt: Date;
    isRead?: boolean;
    type?: 'reminder' | 'announcement' | 'class_cancelled';
    relatedClassId?: string;
  }) {
    const n = await prisma.notification.create({
      data: {
        recipientType: overrides.recipientType,
        recipientId: overrides.recipientId,
        type: overrides.type ?? 'reminder',
        title: 'Fallback test',
        body: 'Fallback test body',
        isRead: overrides.isRead ?? false,
        emailSent: false,
        createdAt: overrides.createdAt,
        relatedClassId: overrides.relatedClassId ?? null,
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
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Email fallback tests',
        pageSlug: `fallback-teacher-${uniqueSuffix}`,
        // UTC so the urgency fixtures' wall-clock math equals the instant.
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Fallback Studio',
        address: `${uniqueSuffix} Fallback St`,
        city: 'Amsterdam',
        postcode: '1111FB',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function makeClassStartingIn(minutesFromNow: number) {
      const start = new Date(Date.now() + minutesFromNow * 60 * 1000);
      const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      const startTime = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`;
      const cls = await createClassFixture(prisma, {
          teacherId,
          teacherRoomId: teacherRoom.id,
          classType: 'Vinyasa',
          date,
          startTime: hhmmToTime(startTime),
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'open',
        });
      classIds.push(cls.id);
      return cls;
    }
    soonClassId = (await makeClassStartingIn(60)).id;
    laterClassId = (await makeClassStartingIn(180)).id;

    // A non-UTC teacher pins the call-site wiring into classStartInstant:
    // if the wall clock were misread as UTC, this class would compute
    // hours away and the urgent test below would fail.
    const amsTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Ams',
        lastName: 'Teacher',
        email: `fallback-ams-${uniqueSuffix}@test.local`,
        account: { create: { email: `fallback-ams-${uniqueSuffix}@test.local` } },
        bio: 'Timezone wiring fixture',
        pageSlug: `fallback-ams-${uniqueSuffix}`,
        defaultTimezone: 'Europe/Amsterdam',
      },
    });
    amsTeacherId = amsTeacher.id;
    const amsTeacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: amsTeacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    const amsStart = new Date(Date.now() + 60 * 60 * 1000);
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(amsStart).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
    );
    const amsClass = await createClassFixture(prisma, {
        teacherId: amsTeacherId,
        teacherRoomId: amsTeacherRoom.id,
        classType: 'Vinyasa',
        date: new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))),
        startTime: hhmmToTime(`${parts.hour}:${parts.minute}`),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      });
    classIds.push(amsClass.id);
    amsClassId = amsClass.id;

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
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    await prisma.student.delete({ where: { id: optedOutStudentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    if (amsTeacherId) {
      await prisma.teacher.delete({ where: { id: amsTeacherId } });
    }
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

    // Type 'reminder' is optional, so emailNotifications=false wins: no
    // email goes out, but the row must be marked so the cron does not pick
    // it up again every run.
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: optedOut.id } });
    expect(after.emailSent).toBe(true);
  });

  it('essential notification to an opted-out student flows through the pipeline (send itself pinned in the consent tests)', async () => {
    const essential = await makeNotification({
      recipientType: 'student',
      recipientId: optedOutStudentId,
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
      type: 'class_cancelled',
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: essential.id } });
    expect(after.emailSent).toBe(true);
  });

  it('emails a fresh notification when its class starts within 2 hours', async () => {
    const urgent = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      relatedClassId: soonClassId,
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: urgent.id } });
    expect(after.emailSent).toBe(true);
  });

  it('emails a fresh notification for a non-UTC teacher whose class starts within 2 hours', async () => {
    const urgent = await makeNotification({
      recipientType: 'teacher',
      recipientId: amsTeacherId,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      relatedClassId: amsClassId,
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: urgent.id } });
    expect(after.emailSent).toBe(true);
  });

  it('leaves a fresh notification whose class is beyond the urgent window', async () => {
    const notYet = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      relatedClassId: laterClassId,
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notYet.id } });
    expect(after.emailSent).toBe(false);
  });

  // The claim, which only the real-send path can show. `processEmailFallback`
  // has two triggers — `POST /api/cron/email-fallback` and the in-process
  // scheduler's 5-minute timer — and the candidate query filters on
  // `emailSent: false` without claiming anything, so two sweeps can hold the
  // same row at once. What decides whether the recipient gets one email or
  // two is which side of the send the mark falls on.
  describe('claiming a notification before sending it', () => {
    const savedApiKey = process.env.RESEND_API_KEY;
    const savedDryRun = process.env.EMAIL_DRY_RUN;
    const perTestNotificationIds: string[] = [];

    async function makeEligible() {
      const n = await makeNotification({
        recipientType: 'teacher',
        recipientId: teacherId,
        createdAt: new Date(Date.now() - 45 * 60 * 1000),
      });
      perTestNotificationIds.push(n.id);
      return n;
    }

    beforeAll(() => {
      // Force the real-send path: a key is configured and dry-run is off.
      process.env.RESEND_API_KEY = 're_test_dummy';
      delete process.env.EMAIL_DRY_RUN;
    });

    afterAll(() => {
      if (savedApiKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = savedApiKey;
      if (savedDryRun === undefined) delete process.env.EMAIL_DRY_RUN;
      else process.env.EMAIL_DRY_RUN = savedDryRun;
    });

    beforeEach(() => {
      sendMock.mockReset();
      sendMock.mockResolvedValue({ error: null });
    });

    // Three of these tests deliberately leave their row unsent, which makes it
    // a candidate again in the next test's sweep and would inflate that test's
    // send count. Deleted rather than marked, so no test here depends on the
    // residue of the one before it.
    afterEach(async () => {
      await prisma.notification.deleteMany({
        where: { id: { in: perTestNotificationIds.splice(0) } },
      });
    });

    it('sends one email when two sweeps overlap on the same notification', async () => {
      const notification = await makeEligible();

      let interposed = 0;
      const overlapping = prisma.$extends({
        query: {
          notification: {
            async findMany({ args, query }) {
              const rows = await query(args);
              // Keyed on the candidate read's shape, not on call order:
              // `getUnreadForEmailFallback` is the only reader asking for
              // unread AND unsent, so an unrelated `findMany` added later
              // cannot silently steal this hook's one shot.
              const where = args.where as { isRead?: unknown; emailSent?: unknown } | undefined;
              if (where?.isRead !== false || where?.emailSent !== false) return rows;
              if (interposed > 0) return rows;
              interposed += 1;
              // A whole second sweep — on the plain client, so it never
              // re-enters this hook — landing between this sweep's candidate
              // read and its first claim. That is exactly the interleaving the
              // 5-minute scheduler and a cron request produce; two sweeps in a
              // `Promise.all` only reach it by luck.
              await processEmailFallback(prisma);
              return rows;
            },
          },
        },
        // `$extends` returns a client missing `$on`, so it is not assignable
        // to `processEmailFallback`'s `PrismaClient`-typed `db` parameter even
        // though every method it calls here is the real one, running against
        // the real database — same cast as the `class-transitions.test.ts`
        // precedent.
      }) as unknown as PrismaClient;

      const outerSent = await processEmailFallback(overlapping);

      // The inbox first, not the counter: two here is the recipient reading
      // the same fallback email twice.
      expect(sendsTo(teacherEmail)).toBe(1);
      expect(interposed).toBe(1);
      // The interposed sweep won the claim; this one found it taken and skipped.
      expect(outerSent).toBe(0);
      const after = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(after.emailSent).toBe(true);
    });

    it('releases the claim when Resend reports a failure, so the next sweep retries', async () => {
      const notification = await makeEligible();
      sendMock.mockResolvedValueOnce({ error: { message: 'boom' } });

      await expect(processEmailFallback(prisma)).rejects.toThrow(/failed/);

      expect(sendsTo(teacherEmail)).toBe(1);
      // Claimed, then released — a claim left standing would silently retire a
      // notification whose email never went out.
      const after = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(after.emailSent).toBe(false);
    });

    it('releases the claim when the send throws', async () => {
      const notification = await makeEligible();
      sendMock.mockRejectedValueOnce(new Error('socket hang up'));

      await expect(processEmailFallback(prisma)).rejects.toThrow(/failed/);

      const after = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(after.emailSent).toBe(false);
    });

    it('names the stranded claim in the thrown error when the release itself fails', async () => {
      const notification = await makeEligible();
      sendMock.mockResolvedValueOnce({ error: { message: 'boom' } });

      const unreleasable = prisma.$extends({
        query: {
          notification: {
            async updateMany({ args, query }) {
              // The release is the only write in this flow that sets
              // `emailSent` false; the claim sets it true. Keyed on that
              // rather than on call order, like the claim hook below.
              if ((args.data as { emailSent?: unknown }).emailSent !== false) return query(args);
              throw new Error('release write failed');
            },
          },
        },
        // Same cast, same reason as the hooks above and below.
      }) as unknown as PrismaClient;

      // The failure count alone would say "1 of 1 sends failed", which an
      // operator reads as "the next sweep will retry it". This one will not:
      // the claim is stuck on, so the row leaves the candidate pool forever.
      // The thrown message is the only place that fact reaches anyone who is
      // not already reading logs.
      await expect(processEmailFallback(unreleasable)).rejects.toThrow(
        /1 of 1 sends failed; 1 claim\(s\) could not be released and will never be retried/,
      );

      // Stranded, and asserted so the message is not merely decorative: an
      // email that never went out on a row that says it did.
      const after = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(after.emailSent).toBe(true);
    });

    it('does not send when the claim itself fails', async () => {
      const notification = await makeEligible();

      let claimAttempts = 0;
      const unclaimable = prisma.$extends({
        query: {
          notification: {
            async updateMany({ args, query }) {
              // The claim is the only write in this flow that sets `emailSent`
              // true; the release sets it false. Keyed on that rather than on
              // call order.
              if ((args.data as { emailSent?: unknown }).emailSent !== true) return query(args);
              claimAttempts += 1;
              throw new Error('claim write failed');
            },
          },
        },
        // Same cast, same reason as the hook above.
      }) as unknown as PrismaClient;

      // The sweep must REPORT this, not just survive it. A claim that failed
      // sent nothing, and if that were skipped as quietly as a claim another
      // sweep already holds, a claim-write outage would email nobody while
      // `processEmailFallback` returned 0 and threw nothing — green health
      // through a total outage. Asserted before the rest because it is the
      // property whose failure names the defect.
      await expect(processEmailFallback(unclaimable)).rejects.toThrow(
        /email fallback: 1 of 1 sends failed/,
      );

      // Fail closed: "we could not record ownership" is not "we own it".
      expect(sendsTo(teacherEmail)).toBe(0);
      expect(claimAttempts).toBe(1);
      const after = await prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(after.emailSent).toBe(false);
    });
  });
});
