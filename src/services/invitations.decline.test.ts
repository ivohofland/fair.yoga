import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact, declineInvitation } from './invitations';
import { deleteStudentAccount } from './gdpr';

// `invitations.ts` imports `@/lib/log`, so the specifier here must match
// that one — the same constraint `invitations.gate.test.ts` documents for
// its own mock.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('a decline writes a suppression entry that survives erasure (#522)', () => {
  afterAll(async () => {
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
    const student = await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
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
});
