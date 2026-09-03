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
  // A second teacher, used below to prove the roster-link guard
  // (`student.teacherStudents.length > 0`) is scoped to the CALLER's
  // `teacherId`, not "does this student have any teacher at all".
  let otherTeacherId: string;

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

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Notify', lastName: 'OtherTeacher',
        email: `notify-guard-other-teacher-${suffix}@test.local`,
        account: { create: { email: `notify-guard-other-teacher-${suffix}@test.local` } },
        bio: 'F3/F4 send-channel guard tests — cross-teacher scoping',
        pageSlug: `notify-guard-other-teacher-${suffix}`,
      },
    });
    otherTeacherId = other.id;
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
    if (otherTeacherId) {
      await prisma.teacherBlock.deleteMany({ where: { teacherId: otherTeacherId } });
      const otherAccountId = (await prisma.teacher.findUnique({
        where: { id: otherTeacherId },
        select: { accountId: true },
      }))?.accountId;
      await prisma.teacher.delete({ where: { id: otherTeacherId } });
      if (otherAccountId) await prisma.account.delete({ where: { id: otherAccountId } });
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

  it('rejects an un-normalised address rather than silently missing the block (#170)', async () => {
    // Cause B, #170 Task 3b: this used to prove `notifyInvitee` tolerated
    // uppercase by lowercasing it before the `TeacherBlock` re-check. #170
    // Task 3 deleted that lowercasing — every caller is now expected to
    // supply an already-normalised address (Zod's `emailField` on the HTTP
    // side, a `*_email_lowercase_check` column on the DB side) — so this now
    // proves the OTHER half of the same guard: an un-normalised address is
    // rejected loudly (`requireNormalised`, src/lib/schemas.ts) instead of
    // silently missing the block and mailing the exact person who set it.
    const email = `Notify-Blocked-${suffix}@Test.Local`;

    await expect(
      notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' }),
    ).rejects.toThrow(/un-normalised/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends nothing at all for a blocked address', async () => {
    // The behaviour the deleted test above used to cover from the tolerant
    // side: a properly-lowercase blocked address still gets no send. F3:
    // `notifyInvitee` re-queries `TeacherBlock` itself rather than trusting a
    // `delivered` value computed earlier by its caller. This calls
    // `notifyInvitee` directly — bypassing `POST /api/students`' own
    // `delivered` gate entirely — so it is the guard INSIDE `notifyInvitee`
    // under test here, not the caller's.
    const email = `notify-blocked-${suffix}@test.local`;
    let studentId: string | undefined;
    let blockId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'Blocked', email },
        select: { id: true },
      });
      studentId = student.id;
      const block = await prisma.teacherBlock.create({
        data: { teacherId, email },
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

  it('sends nothing at all to a student already on this teacher\'s roster (#412)', async () => {
    // The fall-through invitation #412's gate creates is a real, pending row,
    // so `POST /api/invitations/[id]/resend` can reach it — and that route
    // gates only on `declined`/`not pending` before calling
    // `deliverInvitation`. The guard under test is therefore the only thing
    // standing between a resend and a "would like to connect" notification
    // sent to someone already connected.
    const email = `notify-linked-${suffix}@test.local`;
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'Linked', email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      // Not merely "no notification": the unregistered branch below it must
      // not fire either, or the student gets a stranger's sign-up email for
      // a teacher they already have.
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });

  it('still notifies when the student is linked to a DIFFERENT teacher, not the caller', async () => {
    // Two independent reviewers each manually deleted `where: { teacherId }`
    // from this guard's `teacherStudents` select and found the entire unit
    // suite still green — this teacher-scoping was completely untested. The
    // guard above ("already on this teacher's roster") must read "linked to
    // THIS caller", not "linked to some teacher" — conflating them would
    // silently suppress delivery to a student who has never met the caller,
    // just because the student has some other teacher: non-delivery, no
    // error, no log.
    const email = `notify-other-teacher-linked-${suffix}@test.local`;
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'OtherTeacherLinked', email,
          teacherStudents: { create: { teacherId: otherTeacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(1);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });
});
