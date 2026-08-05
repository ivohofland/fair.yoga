import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * #166 Task 11 review (F3, and the "one thing to check" on the account-email
 * handoff). Both gaps are about what `/account/privacy` actually RENDERS,
 * not what an API route accepts — `privacy-api.test.ts`'s "archived link"
 * test already proves `hasTeacherLink` accepts a write against one; it says
 * nothing about whether the page ever shows that teacher's card to write to
 * in the first place. Same shape as `security-headers.test.ts`: fetch the
 * page HTML directly (no JSON body exists to decode) and assert on its text.
 */
describe('GET /account/privacy (page)', () => {
  let studentId: string;
  let studentAccountId: string;
  let studentToken: string;
  let archivedTeacherId: string;
  let inviteTeacherId: string;

  // Mixed case, and deliberately different from `Student.email` below: this
  // is what proves the page matches a pending invitation through the
  // session's own account email rather than `Student.email` — the same
  // address on both would let that swap pass by coincidence.
  const accountEmail = `T11-Page-Verify-${suffix}@Test.Local`;

  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'PageVerify', lastName: 'Student',
        // Deliberately NOT `accountEmail` — stands in for a contact address
        // that has drifted from the account's login identity over time
        // (nothing keeps the two in sync after the initial claim). If the
        // page ever read `Student.email` here instead of the session's own
        // account email, this fixture makes that swap produce a mismatch
        // against the invitation below rather than an accidental match.
        email: `page-verify-legacy-${suffix}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: accountEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const archivedTeacher = await prisma.teacher.create({
      data: {
        firstName: 'PageArchived', lastName: 'Teacher',
        email: `page-archived-teacher-${suffix}@test.local`,
        account: { create: { email: `page-archived-teacher-${suffix}@test.local` } },
        bio: 'F3 fixture — archived TeacherStudent link',
        pageSlug: `page-archived-teacher-${suffix}`,
      },
    });
    archivedTeacherId = archivedTeacher.id;
    await prisma.teacherStudent.create({
      data: { teacherId: archivedTeacherId, studentId, isArchived: true },
    });

    const inviteTeacher = await prisma.teacher.create({
      data: {
        firstName: 'PageInvite', lastName: 'Teacher',
        email: `page-invite-teacher-${suffix}@test.local`,
        account: { create: { email: `page-invite-teacher-${suffix}@test.local` } },
        bio: 'account-email handoff fixture',
        pageSlug: `page-invite-teacher-${suffix}`,
      },
    });
    inviteTeacherId = inviteTeacher.id;
    // `Invitation.email` is always lowercase by construction (`inviteContact`
    // normalises on write) — this fixture writes it directly, so it has to
    // match that convention itself.
    await prisma.invitation.create({
      data: {
        teacherId: inviteTeacherId, email: accountEmail.toLowerCase(),
        firstName: 'PageVerify', lastName: 'Student',
      },
    });
  });

  afterAll(async () => {
    if (inviteTeacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId: inviteTeacherId } });
    }
    if (studentId) {
      await prisma.teacherStudent.deleteMany({ where: { studentId } });
    }
    const teacherIds = [archivedTeacherId, inviteTeacherId].filter(Boolean);
    if (teacherIds.length) {
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    }
    if (studentAccountId) {
      await prisma.session.deleteMany({ where: { accountId: studentAccountId } });
    }
    if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
    // The two teacher accounts are plain lowercase `test.local` addresses
    // and match this; `accountEmail` above does not (mixed case, `.Local`),
    // so the student's own account is deleted explicitly below.
    await prisma.account.deleteMany({ where: { email: { contains: `-${suffix}@test.local` } } });
    if (studentAccountId) await prisma.account.deleteMany({ where: { id: studentAccountId } });
    await prisma.$disconnect();
  });

  it('renders an archived teacher link — archiving is a teacher-side view, not a revoke (review F3)', async () => {
    const res = await fetch(`${BASE_URL}/account/privacy`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('PageArchived Teacher');
  });

  it('matches a pending invitation through the session account email, not Student.email, case-insensitively', async () => {
    const res = await fetch(`${BASE_URL}/account/privacy`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('PageInvite Teacher');
  });

  /**
   * #166 whole-branch review I5. `studentNotificationHref` has its own unit
   * tests; those say nothing about whether `/updates` calls it. A helper
   * that is written, unit-tested and not wired in reads as covered while
   * protecting nothing — the same failure mode Task 9's review caught one
   * component over.
   *
   * `NotificationList` is a client component that navigates through the
   * router rather than an anchor, so there is no href in the HTML to assert
   * on. What it does render for a linkable row, and only for a linkable
   * row, is a trailing arrow. Asserted differentially against a
   * deliberately unlinkable notification for the same student, so a page
   * that happened to contain an arrow of its own would fail the control
   * rather than pass both.
   */
  it('renders the invitation notification as linkable on /updates, and a class-less one as not', async () => {
    let invitation: { id: string } | undefined;
    let plain: { id: string } | undefined;
    try {
      // No `relatedClassId` on either — that is the whole point. One is a
      // type with somewhere to go; the other is not.
      invitation = await prisma.notification.create({
        data: {
          recipientType: 'student', recipientId: studentId, type: 'teacher_invitation',
          title: 'PageInvite invitation row', body: 'A teacher would like to connect.',
        },
        select: { id: true },
      });

      const withInvitation = await fetch(`${BASE_URL}/updates`, { headers: cookie(studentToken) });
      expect(withInvitation.status).toBe(200);
      // Reduced to a boolean before asserting, and carrying its own
      // message: a `toContain` against a whole rendered page prints the
      // page on failure, which buries the one fact the assertion is about.
      expect(
        (await withInvitation.text()).includes('→'),
        'the teacher_invitation row on /updates renders no link target',
      ).toBe(true);

      await prisma.notification.delete({ where: { id: invitation.id } });
      invitation = undefined;

      plain = await prisma.notification.create({
        data: {
          recipientType: 'student', recipientId: studentId, type: 'announcement',
          title: 'PageInvite plain row', body: 'Bring a mat.',
        },
        select: { id: true },
      });

      const withPlain = await fetch(`${BASE_URL}/updates`, { headers: cookie(studentToken) });
      expect(withPlain.status).toBe(200);
      // The control: if the page carried an arrow of its own, the assertion
      // above would be vacuous and this is what catches that.
      expect(
        (await withPlain.text()).includes('→'),
        'the page renders an arrow for a row that has nowhere to go, so the assertion above proves nothing',
      ).toBe(false);
    } finally {
      if (invitation) await prisma.notification.deleteMany({ where: { id: invitation.id } });
      if (plain) await prisma.notification.deleteMany({ where: { id: plain.id } });
    }
  });
});
