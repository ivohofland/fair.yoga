import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact, declineInvitation, listDeclinedTeachers } from './invitations';
import { deleteStudentAccount } from './gdpr';
import { resolveInvitationOnLink } from './link-consent';

// `invitations.ts` imports `@/lib/log`, so the specifier here must match
// that one — the same constraint `invitations.gate.test.ts` documents for
// its own mock.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('a decline writes a suppression entry that survives erasure (#522)', () => {
  // Every case below builds its own teacher/student pair via
  // `makeTeacherAndInvitee` rather than sharing one across the `describe`
  // (unlike `invitations.gate.test.ts`'s single `beforeAll` teacher), so
  // cleanup collects ids across every call instead of populating them once.
  const teacherIds: string[] = [];
  const teacherAccountIds: string[] = [];
  const studentIds: string[] = [];

  afterAll(async () => {
    if (studentIds.length) {
      // `Student.accountId` is the FK and there is no cascade, so the
      // account ids are read back here rather than carried from creation —
      // `makeTeacherAndInvitee` has no other use for them.
      const accounts = await prisma.student.findMany({
        where: { id: { in: studentIds } },
        select: { accountId: true },
      });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
      const studentAccountIds = accounts
        .map((s) => s.accountId)
        .filter((id): id is string => id !== null);
      if (studentAccountIds.length) {
        await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
      }
    }
    if (teacherIds.length) {
      // `Invitation` and `TeacherBlock` both cascade on `Teacher` delete
      // (`onDelete: Cascade`); deleted explicitly first anyway, the same
      // belt-and-suspenders style `invitations.gate.test.ts` uses.
      await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    }
    if (teacherAccountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: teacherAccountIds } } });
    }
    await prisma.$disconnect();
  });

  async function makeTeacherAndInvitee() {
    const email = `decliner-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`;
    const teacherEmail = `teacher-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tess',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: '#522 decline-suppression fixture',
        pageSlug: `tess-${suffix}-${crypto.randomBytes(3).toString('hex')}`,
      },
    });
    teacherIds.push(teacher.id);
    teacherAccountIds.push(teacher.accountId);
    const student = await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true },
    });
    studentIds.push(student.id);
    return { teacher, student, email };
  }

  async function invite(teacherId: string, email: string) {
    const result = await inviteContact(prisma, {
      teacherId,
      email,
      firstName: 'Sam',
      lastName: 'Student',
    });
    if (!result.ok) throw new Error(`invite refused: ${result.reason}`);
    return result.value;
  }

  it('refuses delivery when a declined invitee erases and is re-invited at their real address', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    const declined = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(declined).toEqual({ ok: true });

    // Erasure rewrites Invitation.email, so the (teacherId, email) key the
    // refusal used to live on no longer matches the address the teacher types.
    await deleteStudentAccount(prisma, student.id);

    const reinvited = await invite(teacher.id, email);
    expect(reinvited.delivered).toBe(false);
  });

  it('writes a block for the declining pair', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).not.toBeNull();
  });

  it('still answers DECLINED to a re-invite before any erasure — the block never reaches that gate', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const again = await inviteContact(prisma, {
      teacherId: teacher.id,
      email,
      firstName: 'Sam',
      lastName: 'Student',
    });
    expect(again).toEqual({ ok: false, reason: 'DECLINED' });
  });

  it('writes no block when the CAS misses, so a non-pending row cannot silently suppress', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: teacher.id, email } });

    // The row is already `declined`, so the CAS matches nothing.
    const second = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(second).toEqual({ ok: false, reason: 'NOT_PENDING' });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  it('rolls back the status write when the block upsert fails mid-transaction', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    // A client extension that makes only this one call fail, propagated
    // through to `$transaction`'s `tx` — proves the status write and the
    // block upsert commit or fail together, which is the whole reason
    // `declineInvitation` wraps them in one transaction rather than issuing
    // them as two independent statements.
    const failingBlock = prisma.$extends({
      query: {
        teacherBlock: {
          upsert() {
            throw new Error('boom');
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(
      declineInvitation(failingBlock, { invitationId: invitation.id, accountEmail: email }),
    ).rejects.toThrow('boom');

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { status: true },
    });
    expect(row.status).toBe('pending');

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  it('a booking clears a decline-written block and returns the row to accepted', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    // What POST /api/registrations does inside `!isTeacher` on a booking that
    // created the link — the student's own act, which is the only thing that
    // lifts a block.
    await prisma.$transaction(async (tx) => {
      await resolveInvitationOnLink(tx, {
        teacherId: teacher.id,
        studentEmail: email,
        linkOutcome: 'created',
      });
    });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();

    const row = await prisma.invitation.findUnique({
      where: { id: invitation.id },
      select: { status: true },
    });
    expect(row?.status).toBe('accepted');
  });

  it('a returning erased decliner clears the surviving block by booking', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await deleteStudentAccount(prisma, student.id);

    // The block is what survived the scrub — assert it, or the final
    // `toBeNull` below would pass just as well against an erasure that had
    // deleted it, which is the regression this test exists to catch.
    const survived = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(survived).not.toBeNull();

    // They come back: a new account and Student row on the same address.
    const account = await prisma.account.create({ data: { email } });
    const returning = await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        incomeTier: 3,
        accountId: account.id,
        claimedAt: new Date(),
      },
    });
    // Registered in the same teardown array the helper populates — this
    // Student/Account pair is created outside `makeTeacherAndInvitee`, but
    // the `afterAll` above resolves each student's `accountId` from the row
    // itself, so pushing the id here is enough to reach both deletes.
    studentIds.push(returning.id);

    await prisma.$transaction(async (tx) => {
      await resolveInvitationOnLink(tx, {
        teacherId: teacher.id,
        studentEmail: email,
        linkOutcome: 'created',
      });
    });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  it('lists a teacher whose invitation this account declined', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
    expect(rows.map((r) => r.teacher.pageSlug)).toContain(teacher.pageSlug);
  });

  it('lists nothing once the account is erased, even though the block survives', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await deleteStudentAccount(prisma, student.id);

    // The block is still there — it is what keeps the suppression working.
    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).not.toBeNull();

    // The narrative is not. A new account on this address learns nothing
    // about the erased person's refusal.
    const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
    expect(rows).toEqual([]);
  });

  it('lists nothing for a pair that is currently linked', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });

    const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
    expect(rows).toEqual([]);
  });
});
