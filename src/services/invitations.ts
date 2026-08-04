/**
 * Invitations Service — acceptance-gated linking between a teacher and a
 * student (#166).
 *
 * A teacher can no longer put a person on their roster by typing an email
 * address. They create an `Invitation`; the link only exists once the invitee
 * accepts. Everything a teacher can learn from this module is about rows the
 * teacher already owns.
 */

import type { PrismaClient } from '@prisma/client';

export type InviteRefusal = 'ALREADY_INVITED' | 'ALREADY_LINKED' | 'DECLINED';

export interface InviteResult {
  id: string;
}

export const REFUSAL_MESSAGES: Record<InviteRefusal, string> = {
  ALREADY_INVITED: 'You have already invited this person.',
  ALREADY_LINKED: 'This person is already one of your students.',
  DECLINED: 'This person declined your invitation.',
};

/**
 * Create a CRM contact and invite its owner.
 *
 * The security property lives in what this function does NOT branch on.
 * Every refusal below is about a row THIS teacher owns — their own
 * invitation, their own roster link — so answering is not a disclosure.
 * Nothing else is consulted. In particular there is no "does a Student
 * row exist for this address" branch, which is what made the old route an
 * account-enumeration oracle: 200 meant taken, 201 meant free.
 *
 * The Student lookup below is deliberately AFTER the outcome is fixed and
 * feeds only the roster-link check. Do not hoist it, and do not add a
 * branch on `student === null`.
 */
export async function inviteContact(
  db: PrismaClient,
  input: { teacherId: string; email: string; firstName: string; lastName: string },
): Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }> {
  const { teacherId, email, firstName, lastName } = input;

  const existing = await db.invitation.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { status: true },
  });
  if (existing) {
    if (existing.status === 'declined') return { ok: false, reason: 'DECLINED' };
    if (existing.status === 'accepted') return { ok: false, reason: 'ALREADY_LINKED' };
    return { ok: false, reason: 'ALREADY_INVITED' };
  }

  // A link with no invitation row: this student booked a class instead of
  // being invited. Their being on this teacher's roster is the teacher's
  // own data, so refusing here discloses nothing new.
  const student = await db.student.findUnique({ where: { email }, select: { id: true } });
  if (student) {
    const link = await db.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: student.id } },
      select: { id: true },
    });
    if (link) return { ok: false, reason: 'ALREADY_LINKED' };
  }

  const created = await db.invitation.create({
    data: { teacherId, email, firstName, lastName },
    select: { id: true },
  });
  return { ok: true, value: { id: created.id } };
}
