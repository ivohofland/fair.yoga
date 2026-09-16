import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { notifyInvitee, deliverInvitation } from './invitations';
import { teardownTeacher } from '../../tests/helpers';

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
    let invitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'DoubleSend', email },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'DoubleSend' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

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
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
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
    let invitationId: string | undefined;
    try {
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'Stranger' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

      expect(sendMock).toHaveBeenCalledTimes(1);
      const [args] = sendMock.mock.calls[0] as [{ to: string }];
      expect(args.to).toBe(email);
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
    }
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
    let invitationId: string | undefined;
    try {
      // `notifyInvitee` now requires a real `invitationId`, so this test
      // needs a row too — but the un-normalised address above is what's
      // under test, not this row's own address, so it gets a distinct
      // fixture email of its own rather than the normalised form of the one
      // above (which would collide with the blocked-address test's fixture
      // on `Invitation`'s `(teacherId, email)` unique key).
      const invitation = await prisma.invitation.create({
        data: { teacherId, email: `notify-unnormalised-fixture-${suffix}@test.local`, firstName: 'Notify', lastName: 'Blocked' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await expect(
        notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id }),
      ).rejects.toThrow(/un-normalised/);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
    }
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
    let invitationId: string | undefined;
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
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'Blocked' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
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
    let invitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'Linked', email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'Linked' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      // Not merely "no notification": the unregistered branch below it must
      // not fire either, or the student gets a stranger's sign-up email for
      // a teacher they already have.
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });

  it('sets no failure signal when an already-linked pair is resent via deliverInvitation (#392 review, Important #7)', async () => {
    // Spec Tests item 3, dropped from the original plan: this asserted the
    // already-linked branch at the `notifyInvitee`-unit level only via the
    // test above. Going one layer out to `deliverInvitation` — the shape
    // `POST /api/invitations/[id]/resend` actually calls, with no `delivered`
    // gate of its own — additionally proves the dispatch's own
    // failure-recording never fires for this path.
    const email = `notify-linked-deliver-${suffix}@test.local`;
    const controlEmail = `notify-linked-deliver-control-${suffix}@test.local`;
    let studentId: string | undefined;
    let invitationId: string | undefined;
    let controlStudentId: string | undefined;
    let controlInvitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'LinkedDeliver', email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'LinkedDeliver' },
        select: { id: true },
      });
      invitationId = invitation.id;

      // `student.findUnique` is `notifyInvitee`'s second query on both the
      // already-linked and the ordinary registered path, and its resolution
      // is the direct synchronization point this test needs — NOT relative
      // timing between the two dispatches below. An earlier version of this
      // test bracketed the already-linked dispatch by waiting for a SECOND,
      // "ordinary" dispatch's own notification to land, reasoning that the
      // already-linked path (early return) does less work than the
      // ordinary one and so must finish first. That reasoning doesn't hold
      // under connection-pool contention: both dispatches are fire-and-
      // forget and run concurrently, competing for the same pool with no
      // ordering guarantee, so the "faster" path can still resolve its own
      // query AFTER the "slower" one's — and if it resolves after this
      // test's own `finally` has already deleted the row, `student.findUnique`
      // finds nothing and falls through to the stranger email path,
      // polluting whichever later test in this file next asserts on
      // `sendMock`. Spying on the query itself and awaiting every call's own
      // result removes the ordering assumption entirely.
      const studentFindSpy = vi.spyOn(prisma.student, 'findUnique');

      deliverInvitation(prisma, {
        teacherId, email, invitationId: invitation.id, source: 'resend', dispatchedAt: new Date(),      });

      const controlStudent = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'LinkedDeliverControl', email: controlEmail },
        select: { id: true },
      });
      controlStudentId = controlStudent.id;
      const controlInvitation = await prisma.invitation.create({
        data: { teacherId, email: controlEmail, firstName: 'Notify', lastName: 'Control' },
        select: { id: true },
      });
      controlInvitationId = controlInvitation.id;
      deliverInvitation(prisma, {
        teacherId, email: controlEmail, invitationId: controlInvitation.id,
        source: 'resend', dispatchedAt: new Date(),
      });

      await vi.waitFor(() => expect(studentFindSpy.mock.calls.length).toBeGreaterThanOrEqual(2));
      await Promise.all(studentFindSpy.mock.results.map((r) => r.value));

      // The control's own `createNotification` write is a further async
      // step after ITS `student.findUnique` resolves — wait for that
      // specifically too, so the notification-count assertion below isn't
      // itself racing a write still in flight.
      await vi.waitFor(
        () =>
          prisma.notification.findFirst({
            where: { recipientType: 'student', recipientId: controlStudent.id, type: 'teacher_invitation' },
          }),
        { timeout: 2000 },
      );

      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { lastNotifyFailedAt: true },
      });
      expect(after.lastNotifyFailedAt).toBeNull();

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (controlInvitationId) await prisma.invitation.deleteMany({ where: { id: controlInvitationId } });
      if (controlStudentId) {
        await prisma.notification.deleteMany({ where: { recipientId: controlStudentId } });
        await prisma.student.delete({ where: { id: controlStudentId } });
      }
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });

  it('sends nothing at all to a student whose roster link is archived', async () => {
    // Sibling of the #412 case above: this guard's `teacherStudents` select
    // is unfiltered by `isArchived`, same as `rosterLinkState`'s (#424's
    // tripwire, `services/invitations.ts`), so an archived link must still
    // short-circuit both the in-app notification and the direct-email
    // fallback below it.
    const email = `notify-archived-${suffix}@test.local`;
    let studentId: string | undefined;
    let invitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'Archived', email,
          teacherStudents: { create: { teacherId, isArchived: true } },
        },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'Archived' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
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
    let invitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'OtherTeacherLinked', email,
          teacherStudents: { create: { teacherId: otherTeacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'OtherTeacherLinked' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(1);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });

  async function createTeacherOnlyInvitee(
    label: string,
  ): Promise<{ teacherId: string; accountId: string; email: string }> {
    const email = `notify-teacher-invitee-${label}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Invitee', lastName: 'Teacher', email,
        account: { create: { email } },
        bio: '#172 teacher-only invitee fixture',
        pageSlug: `notify-teacher-invitee-${label}-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    return { teacherId: teacher.id, accountId: teacher.accountId, email };
  }

  async function removeTeacherOnlyInvitee(
    invitee: { teacherId: string; accountId: string },
  ): Promise<void> {
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: invitee.teacherId },
    });
    await prisma.teacher.delete({ where: { id: invitee.teacherId } });
    await prisma.account.delete({ where: { id: invitee.accountId } });
  }

  it('tells a teacher-only account in its teacher inbox, and sends no email (#172)', async () => {
    const invitee = await createTeacherOnlyInvitee('inbox');
    let invitationId: string | undefined;
    try {
      const invitation = await prisma.invitation.create({
        data: { teacherId, email: invitee.email, firstName: 'Notify', lastName: 'Inbox' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email: invitee.email, teacherName: 'Some Teacher', invitationId: invitation.id });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'teacher', recipientId: invitee.teacherId, type: 'teacher_invitation' },
        select: { title: true, body: true },
      });
      expect(notifications).toEqual([{
        title: 'A teacher would like to connect',
        body: 'Some Teacher added you as a contact. Connecting adds a student side to your account, and you choose whether to.',
      }]);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      await removeTeacherOnlyInvitee(invitee);
    }
  });

  it('gives an account holding both profiles the student notification only (#172)', async () => {
    const email = `notify-both-profiles-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Both', lastName: 'Profiles', email,
        account: { create: { email } },
        bio: '#172 both-profiles fixture',
        pageSlug: `notify-both-profiles-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const student = await prisma.student.create({
      data: {
        firstName: 'Both', lastName: 'Profiles', email,
        claimedAt: new Date(), accountId: teacher.accountId,
      },
      select: { id: true },
    });
    let invitationId: string | undefined;
    try {
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'BothProfiles' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });

      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      })).toBe(1);
      expect(await prisma.notification.count({
        where: { recipientType: 'teacher', recipientId: teacher.id },
      })).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      await prisma.notification.deleteMany({ where: { recipientId: { in: [student.id, teacher.id] } } });
      await prisma.student.delete({ where: { id: student.id } });
      await prisma.teacher.delete({ where: { id: teacher.id } });
      await prisma.account.delete({ where: { id: teacher.accountId } });
    }
  });

  it('sends nothing at all to a blocked teacher-only account (#172)', async () => {
    // Reachable without this feature writing a block: #171 keeps an erased
    // student's refusal, and the address can later hold a teacher account.
    const invitee = await createTeacherOnlyInvitee('blocked');
    const block = await prisma.teacherBlock.create({
      data: { teacherId, email: invitee.email },
      select: { id: true },
    });
    let invitationId: string | undefined;
    try {
      const invitation = await prisma.invitation.create({
        data: { teacherId, email: invitee.email, firstName: 'Notify', lastName: 'Blocked' },
        select: { id: true },
      });
      invitationId = invitation.id;

      await notifyInvitee(prisma, { teacherId, email: invitee.email, teacherName: 'Some Teacher', invitationId: invitation.id });

      expect(await prisma.notification.count({
        where: { recipientType: 'teacher', recipientId: invitee.teacherId },
      })).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      await prisma.teacherBlock.delete({ where: { id: block.id } });
      await removeTeacherOnlyInvitee(invitee);
    }
  });

  /** A teacher-only account plus a pending invitation to it from `teacherId`. */
  async function teacherOnlyInvitee(slug: string) {
    const email = `notify-cap-${slug}-${suffix}@test.local`;
    const invitee = await prisma.teacher.create({
      data: {
        firstName: 'Cap', lastName: 'Invitee', email,
        account: { create: { email } },
        bio: '#622 teacher-inbox dispatch cap',
        pageSlug: `notify-cap-${slug}-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Invitee' },
      select: { id: true },
    });
    return { email, inviteeTeacherId: invitee.id, accountId: invitee.accountId, invitationId: invitation.id };
  }

  async function cleanUpInvitee(f: { inviteeTeacherId: string; accountId: string; invitationId: string }) {
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: f.inviteeTeacherId },
    });
    await prisma.invitation.deleteMany({ where: { id: f.invitationId } });
    await teardownTeacher(prisma, f.inviteeTeacherId, f.accountId);
  }

  const countTeacherNotifications = (recipientId: string) =>
    prisma.notification.count({
      where: { recipientType: 'teacher', recipientId, type: 'teacher_invitation' },
    });

  it('tells a teacher-only invitee once, and a repeat dispatch not at all (#622)', async () => {
    const f = await teacherOnlyInvitee('repeat');
    try {
      const dispatch = () => notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      await dispatch();
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
      await dispatch();
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('tells an address that gained a teacher profile after an earlier dispatch (#622, sequence 1)', async () => {
    // The dead end this replaces: the first dispatch took the stranger-email
    // branch and the routes wrote their markers anyway, so a suppression
    // reading those markers never told this person at all.
    const email = `notify-cap-seq1-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Seq1' },
      select: { id: true },
    });
    let inviteeTeacherId: string | undefined;
    let accountId: string | undefined;
    try {
      // No account yet: the stranger branch runs.
      await notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      expect(sendMock).toHaveBeenCalledTimes(1);

      const invitee = await prisma.teacher.create({
        data: {
          firstName: 'Cap', lastName: 'Seq1', email,
          account: { create: { email } },
          bio: '#622 sequence 1', pageSlug: `notify-cap-seq1-${suffix}`,
        },
        select: { id: true, accountId: true },
      });
      inviteeTeacherId = invitee.id;
      accountId = invitee.accountId;

      await notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      expect(await countTeacherNotifications(invitee.id)).toBe(1);
    } finally {
      if (inviteeTeacherId) {
        await prisma.notification.deleteMany({
          where: { recipientType: 'teacher', recipientId: inviteeTeacherId },
        });
        await prisma.teacher.delete({ where: { id: inviteeTeacherId } });
      }
      if (accountId) await prisma.account.delete({ where: { id: accountId } });
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('tells a previously-linked invitee once the student side is gone (#622, sequence 2)', async () => {
    // The dispatch made while the pair was linked returned at the roster-link
    // check without notifying anyone. It must not count as having told them.
    const f = await teacherOnlyInvitee('seq2');
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Cap', lastName: 'Seq2', email: f.email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;

      // Linked: this dispatch notifies nobody.
      await notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(0);

      // The student side is erased: address tombstoned, link removed. The
      // account keeps its address because a live teacher remains.
      await prisma.teacherStudent.deleteMany({ where: { studentId: student.id } });
      await prisma.student.update({
        where: { id: student.id },
        data: { email: `deleted-${student.id}@deleted.invalid`, deletedAt: new Date() },
      });

      await notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
      await cleanUpInvitee(f);
    }
  });

  it('caps nothing for a student invitee — every dispatch still notifies (#622)', async () => {
    const email = `notify-cap-student-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Student' },
      select: { id: true },
    });
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Cap', lastName: 'Student', email },
        select: { id: true },
      });
      studentId = student.id;

      const dispatch = () => notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      await dispatch();
      await dispatch();

      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      })).toBe(2);
    } finally {
      if (studentId) {
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('caps nothing for an address with no account — every dispatch still emails (#622)', async () => {
    const email = `notify-cap-stranger-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Stranger' },
      select: { id: true },
    });
    try {
      const dispatch = () => notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      await dispatch();
      await dispatch();
      expect(sendMock).toHaveBeenCalledTimes(2);
    } finally {
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('creates exactly one notification when two dispatches race (#622)', async () => {
    // The reason the claim is a conditional UPDATE and not a read followed by
    // a write: both of these would observe a null marker under a read-first
    // implementation, and both would notify.
    const f = await teacherOnlyInvitee('race');
    try {
      await Promise.all([
        notifyInvitee(prisma, { teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId }),
        notifyInvitee(prisma, { teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId }),
      ]);
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      await cleanUpInvitee(f);
    }
  });
});
