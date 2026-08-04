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
 *
 * One residual channel is knowingly left open: the "Student exists but is not
 * on this teacher's roster" path issues one extra query, so it is marginally
 * slower than the path where no Student row exists. That is outside the
 * property this function claims — identical status, identical body, identical
 * side effects — and closing it would mean issuing dummy queries to flatten
 * the timing, which is not worth the contortion at this threat level.
 */
export async function inviteContact(
  db: PrismaClient,
  input: { teacherId: string; email: string; firstName: string; lastName: string },
): Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }> {
  const { teacherId, firstName, lastName } = input;

  // The CRM is the one place in this app where one human types ANOTHER
  // human's address, and a case slip here fails silently: the teacher sees a
  // pending invitation, the student never sees anything. So invitation emails
  // are normalised on write, and this column is lowercase by construction.
  //
  // Normalised here rather than in `createInvitationSchema`, because a
  // `.transform()` there would hide the schema's `.shape` from the
  // server-owned-field walk in `src/lib/schemas.test.ts:412-453`.
  //
  // Deliberately scoped to Invitation. Account and Student emails are stored
  // as typed and compared case-sensitively throughout this app (magic-link
  // send looks accounts up with the raw string) — a systemic, pre-existing
  // bug, filed separately, not one to half-fix from in here. Later tasks
  // match an account to an invitation by lowercasing the account's email in
  // JS before querying, which stays index-friendly exactly because this
  // column is always lowercase.
  const email = input.email.toLowerCase();

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
  //
  // The lookup uses the normalised address, so it misses a Student row stored
  // with different case. That fails toward creating an invitation, never
  // toward a disclosure, and it is the same systemic case-sensitivity noted
  // above rather than anything this branch introduces.
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

/**
 * Accept an invitation.
 *
 * Authorization is by ADDRESS, not by id. The invitation id travels in a
 * URL and is not a secret; the account email is what the person proved
 * they own at sign-in. Matching on `accountEmail` is therefore the
 * ownership gate, and `findFirst` puts it in the query rather than in a
 * check after the read. Without this, any signed-in student who guesses or
 * obtains an id accepts on a stranger's behalf — creating a link between
 * two people neither of whom agreed. This is the gate-4 ownership family
 * #146, #148, and #162 all belonged to.
 *
 * `accountEmail` is lowercased before the comparison: `Invitation.email` is
 * written lowercase by `inviteContact` above and by `PUT /api/invitations/[id]`,
 * but `Account.email` is stored exactly as typed at sign-up. Comparing the
 * two without normalising this side would hide a pending invitation from
 * anyone whose account email carries any uppercase.
 */
export async function acceptInvitation(
  db: PrismaClient,
  input: { invitationId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email: input.accountEmail.toLowerCase() },
    select: { id: true, teacherId: true, status: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };
  if (invitation.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };

  await db.$transaction(async (tx) => {
    // `upsert`, not `create`: this student may already share this teacher's
    // roster from booking a class while the invitation sat pending, and
    // accepting must not throw on that overlap.
    await tx.teacherStudent.upsert({
      where: {
        teacherId_studentId: { teacherId: invitation.teacherId, studentId: input.studentId },
      },
      update: {},
      create: { teacherId: invitation.teacherId, studentId: input.studentId },
    });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted', respondedAt: new Date() },
    });
  });
  return { ok: true };
}

/**
 * Decline an invitation. Same ownership gate as `acceptInvitation` above,
 * and for the same reason — see its docblock.
 *
 * No link is created, and the row is not deleted. A declined `Invitation`
 * is the tombstone that stops the teacher re-inviting the same address;
 * `PUT`/`DELETE /api/invitations/[id]` already refuse to edit or remove a
 * declined row for that same reason.
 */
export async function declineInvitation(
  db: PrismaClient,
  input: { invitationId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email: input.accountEmail.toLowerCase() },
    select: { id: true, status: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };
  if (invitation.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };

  await db.invitation.update({
    where: { id: invitation.id },
    data: { status: 'declined', respondedAt: new Date() },
  });
  return { ok: true };
}
