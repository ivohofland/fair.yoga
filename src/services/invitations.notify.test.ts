import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { notifyInvitee } from './invitations';

// `notifyInvitee`'s dry-run branch (src/lib/email.ts) can't tell "sent" from
// "not reached" — a dry run just logs either way. Proving the registered
// path takes ONLY the notification branch, never also the direct email
// (F4, #166 review), needs the real send observable — same technique as
// `email-fallback.consent.test.ts`: mock the Resend SDK itself.
const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('notifyInvitee — send-channel guards (#166 task 8, F3/F4 review)', () => {
  const savedApiKey = process.env.RESEND_API_KEY;
  const savedDryRun = process.env.EMAIL_DRY_RUN;
  // A real row: `notifyInvitee`'s own `TeacherBlock` re-check (F3) only ever
  // READS this id (`findUnique`, no FK needed), but the blocked-address test
  // below writes a `TeacherBlock` row as its fixture, and that write DOES
  // enforce the FK.
  let teacherId: string;

  beforeAll(async () => {
    // Force the real-send path: a key is configured and dry-run is off —
    // otherwise `sendInvitationEmail` never reaches `resend().emails.send`
    // and `sendMock` would stay empty regardless of which branch ran,
    // making every assertion below vacuous.
    process.env.RESEND_API_KEY = 're_test_dummy';
    delete process.env.EMAIL_DRY_RUN;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Notify', lastName: 'Teacher',
        email: `notify-guard-teacher-${suffix}@test.local`,
        account: { create: { email: `notify-guard-teacher-${suffix}@test.local` } },
        bio: 'F3/F4 send-channel guard tests',
        pageSlug: `notify-guard-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    if (teacherId) {
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      const accountId = (await prisma.teacher.findUnique({
        where: { id: teacherId },
        select: { accountId: true },
      }))?.accountId;
      await prisma.teacher.delete({ where: { id: teacherId } });
      if (accountId) await prisma.account.delete({ where: { id: accountId } });
    }

    if (savedApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedApiKey;
    if (savedDryRun === undefined) delete process.env.EMAIL_DRY_RUN;
    else process.env.EMAIL_DRY_RUN = savedDryRun;
    await prisma.$disconnect();
  });

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ error: null });
  });

  it('sends only the in-app notification for a registered invitee, never also the direct email', async () => {
    const email = `notify-double-send-${suffix}@test.local`;
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'DoubleSend', email },
        select: { id: true },
      });
      studentId = student.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(1);
      // The guard under test: `notifyInvitee`'s `if (student) { ...; return; }`
      // (services/invitations.ts) is the only thing stopping a registered
      // student from ALSO getting the direct email below — bypassing
      // `shouldEmailStudent` and their own `emailNotifications` preference.
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (studentId) {
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });

  it('sends the direct email for an unregistered address', async () => {
    // Contrast case: proves `sendMock` above is wired to fire at all — the
    // double-send test's `not.toHaveBeenCalled()` would trivially pass if
    // this file's mock were simply never reached at all.
    const email = `notify-stranger-${suffix}@test.local`;

    await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [args] = sendMock.mock.calls[0] as [{ to: string }];
    expect(args.to).toBe(email);
  });

  it('sends nothing at all for a blocked address, even one typed with uppercase', async () => {
    // Two guards at once, because they are one guard: the block re-check and
    // the `.toLowerCase()` that makes it hit.
    //
    // F3: `notifyInvitee` re-queries `TeacherBlock` itself rather than
    // trusting a `delivered` value computed earlier by its caller. This
    // calls `notifyInvitee` directly — bypassing `POST /api/students`'
    // own `delivered` gate entirely — so it is the guard INSIDE
    // `notifyInvitee` under test here, not the caller's.
    //
    // The address handed in carries uppercase; the `TeacherBlock` row is
    // lowercase, which is the only form that table is ever written in. That
    // pairing is what makes the leading `.toLowerCase()` observable: the
    // block lookup is a `findUnique` on `@@unique([teacherId, email])` and
    // is therefore case-SENSITIVE, so without the normalisation it misses
    // and the send goes out to someone who blocked this teacher. The Student
    // lookup below it cannot show that — it is `mode: 'insensitive'`
    // (whole-branch I2) and finds the row either way — and an all-lowercase
    // fixture address would make the normalisation indistinguishable from
    // its absence.
    const email = `Notify-Blocked-${suffix}@Test.Local`;
    const blockedEmail = email.toLowerCase();
    let studentId: string | undefined;
    let blockId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'Blocked', email: blockedEmail },
        select: { id: true },
      });
      studentId = student.id;
      const block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedEmail },
        select: { id: true },
      });
      blockId = block.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (blockId) await prisma.teacherBlock.deleteMany({ where: { id: blockId } });
      if (studentId) {
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });
});
