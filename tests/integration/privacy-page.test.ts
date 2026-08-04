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

  // Mixed case, and NOT the same string `Student.email` gets below — see
  // the second test for why the two must differ.
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
});
