/**
 * Invitations Service — acceptance-gated linking between a teacher and a
 * student (#166).
 *
 * A teacher can no longer put a person on their roster by typing an email
 * address. They create an `Invitation`; the link only exists once the invitee
 * accepts. Everything a teacher can learn from this module is about rows the
 * teacher already owns.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import { reorderWaitingEntries } from './waitlist';
import { createNotification } from './notifications';
import { sendInvitationEmail } from '@/lib/email';

export type InviteRefusal = 'ALREADY_INVITED' | 'ALREADY_LINKED' | 'DECLINED';

export interface InviteResult {
  id: string;
  /**
   * False when a `TeacherBlock` exists for this (teacher, email) pair, true
   * otherwise. Not a detail — it is the field that stops a caller from
   * notifying on every `ok: true`. `POST /api/students` (route.ts) gates its
   * `notifyInvitee` call (below) on `delivered === true`; that gate is what
   * keeps this from becoming a channel back to the exact person who unlinked
   * to get away from this teacher. The invitation itself is created either
   * way — only delivery is withheld (#166 task 6c; wired in task 8).
   */
  delivered: boolean;
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
 *
 * The block check below runs unconditionally, after the invitation is
 * already created — a blocked and a fresh address run the exact same query
 * sequence, differing only in the `delivered` value neither response ever
 * carries on the wire.
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
    // Every Invitation row left standing is now one the teacher typed
    // themselves — the block that used to live in here has moved to
    // `TeacherBlock` — so a 409 here tells them nothing they did not
    // already have, and silence would be cruelty rather than protection.
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

  // A block makes this invitation undeliverable, not un-creatable. The row
  // is real, the teacher sees it, edits it, archives it — everything behaves
  // exactly as it does for an address that was never blocked, which is the
  // point. Only delivery is withheld. See `delivered` on InviteResult.
  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { id: true },
  });

  return { ok: true, value: { id: created.id, delivered: blocked === null } };
}

/**
 * Tell the invitee an invitation exists — layer 1+2 (in-app notification,
 * which the inbox and the email-fallback cron both pick up) for a
 * registered invitee, a plain email for everyone else (#166 task 8).
 *
 * The caller MUST only reach this when `InviteResult.delivered` is true.
 * `inviteContact` above creates a real, ordinary-looking `Invitation` row
 * for a blocked address on purpose, precisely so the teacher cannot tell
 * blocked from fresh — `delivered` is the one place that distinction is
 * allowed to surface, and only to callers that gate a send on it. A caller
 * that skips the gate turns this into exactly the harassment channel the
 * block exists to close.
 *
 * `delivered` is computed once, at `inviteContact`'s create time. Nothing
 * about the invitation's route from there to here re-checks `TeacherBlock`
 * — the only door that can move `delivered` after creation is
 * `PUT /api/invitations/[id]`, which edits `email` on a pending row without
 * recomputing it. That PUT does not call this function (it does not send
 * anything at all), so no send in this codebase currently trusts a stale
 * `delivered`. Any future send path that isn't `inviteContact`'s own
 * create-time call — a resend, a retry, anything PUT-adjacent — must
 * re-query `TeacherBlock` itself rather than reuse a value read earlier.
 *
 * The `Student` lookup below runs after the caller's response is already
 * decided (`POST /api/students` answers 201 with `{ id }` before this ever
 * runs) and feeds only which delivery channel to use — never the response.
 * Restructuring this so the route's status or body depends on it would
 * reopen the enumeration oracle #166 closed.
 *
 * `teacher_invitation` is deliberately NOT in `ESSENTIAL_NOTIFICATION_TYPES`
 * (`services/notification-policy.ts`), so `shouldEmailStudent` falls
 * through to the student's own `emailNotifications` preference — an
 * invitation from someone they have never met is not a service message
 * about their own booking, so it does not bypass their opt-out the way a
 * booking confirmation does.
 */
export async function notifyInvitee(
  db: PrismaClient,
  input: { teacherId: string; email: string; teacherName: string },
): Promise<void> {
  // `Invitation.email` is always lowercase by the time a caller reaches
  // this (inviteContact normalises on write), but `Student.email` never is
  // — same systemic gap `inviteContact`'s own Student lookup notes above.
  // This function does its own lowercasing rather than trusting a caller
  // already did, the same way every other email-comparing function in this
  // file does (acceptInvitation, unlinkTeacher, resolveInvitationOnLink).
  const email = input.email.toLowerCase();

  const student = await db.student.findUnique({
    where: { email },
    select: { id: true },
  });

  if (student) {
    // The three-layer model handles email from here: the fallback cron
    // picks this up unread after the threshold (or sooner, near a linked
    // class — not applicable here, this notification has none), honouring
    // the student's own preference. No direct send alongside this.
    await createNotification(db, {
      recipientType: 'student',
      recipientId: student.id,
      type: 'teacher_invitation',
      title: 'A teacher would like to connect',
      body: `${input.teacherName} added you as a contact. You choose whether to connect.`,
    });
    return;
  }

  // No Student row means no in-app surface exists to notify — a direct
  // email is the only channel left.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendInvitationEmail(email, input.teacherName, `${baseUrl}/login`);
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
 *
 * The block check below is defence in depth, not the primary gate — the
 * student-side pending query (Task 11) already excludes a blocked pair, so
 * this id should never reach here for one. But the id travels in a URL, not
 * a secret, and this whole function exists because that can't be trusted.
 * It returns the same `NOT_FOUND` as an unknown id, not a distinct code: a
 * distinct code would tell a probing caller that a block exists, which is
 * the exact bit `inviteContact` above withholds.
 */
export async function acceptInvitation(
  db: PrismaClient,
  input: { invitationId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
  const email = input.accountEmail.toLowerCase();
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email },
    select: { id: true, teacherId: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };

  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId: invitation.teacherId, email } },
    select: { id: true },
  });
  if (blocked) return { ok: false, reason: 'NOT_FOUND' };

  // The pending check lives in this `updateMany`'s `where`, not in a read
  // beforehand — a concurrent accept and decline from the same account
  // (the only account that can ever pass the email match above) would
  // otherwise both pass a separate status read and race to leave a
  // `TeacherStudent` link sitting beside a `declined` invitation.
  const accepted = await db.$transaction(async (tx) => {
    const updated = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'accepted', respondedAt: new Date() },
    });
    if (updated.count === 0) return false;

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
    return true;
  });
  if (!accepted) return { ok: false, reason: 'NOT_PENDING' };
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
    select: { id: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };

  // Same reasoning as `acceptInvitation`: the pending check is the
  // `where` on this write, not a separate read beforehand, so a
  // concurrent accept from the same account can't slip past it.
  const updated = await db.invitation.updateMany({
    where: { id: invitation.id, status: 'pending' },
    data: { status: 'declined', respondedAt: new Date() },
  });
  if (updated.count === 0) return { ok: false, reason: 'NOT_PENDING' };
  return { ok: true };
}

/**
 * A student severs a teacher link.
 *
 * Two things this deliberately does not do. It does not delete the
 * Student row when the last link goes — the teacher-side DELETE used to,
 * and that behaviour must not survive into a student-facing route. And it
 * does not touch registrations or payments: those are facts, and money may
 * be owed. The teacher keeps seeing them through the registration-scoped
 * surfaces, which is #167's decision applied here.
 */
export async function unlinkTeacher(
  db: PrismaClient,
  input: { teacherId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_LINKED' }> {
  const link = await db.teacherStudent.findUnique({
    where: {
      teacherId_studentId: { teacherId: input.teacherId, studentId: input.studentId },
    },
    select: { id: true },
  });
  if (!link) return { ok: false, reason: 'NOT_LINKED' };

  await db.$transaction(async (tx) => {
    await tx.teacherStudent.delete({ where: { id: link.id } });

    // A `waiting` entry for one of this teacher's classes is a standing
    // request the student is walking away from along with the link — left
    // in place, it hands the teacher a lever to reach back through it: cancel
    // any other registration in that class, `handleSpotFreed` promotes this
    // student off the queue, and `resolveInvitationOnLink` clears the block
    // being set below, all without the student doing anything. Withdrawing
    // here (rather than having `promoteNext` skip a blocked candidate) is
    // deliberate — skipping leaves a zombie entry that keeps trying and
    // occupying a queue position forever; withdrawing matches the same
    // principle `resolveInvitationOnLink` runs on elsewhere: the student's
    // most recent act governs. Registrations are untouched, on purpose and
    // unlike this: a registration is a commitment that may carry money owed,
    // a waitlist entry is neither.
    const waitingEntries = await tx.waitlistEntry.findMany({
      where: { studentId: input.studentId, status: 'waiting', class: { teacherId: input.teacherId } },
      select: { id: true, classId: true },
    });
    if (waitingEntries.length > 0) {
      await tx.waitlistEntry.updateMany({
        where: { id: { in: waitingEntries.map((entry) => entry.id) } },
        data: { status: 'removed' },
      });
      const classIds = [...new Set(waitingEntries.map((entry) => entry.classId))];
      for (const classId of classIds) {
        await reorderWaitingEntries(tx, classId);
      }
    }

    // Lowercased for the same reason `acceptInvitation` lowercases:
    // `Invitation.email` and `TeacherBlock.email` are always stored
    // lowercase, `Account.email` never is. A raw address here would miss an
    // existing invitation row and write the block under a different casing
    // than `inviteContact` looks it up by.
    const email = input.accountEmail.toLowerCase();

    // An invitation the teacher created keeps its honest declined state —
    // they typed that address, so telling them it is dead discloses nothing
    // and saves them re-sending into silence. `updateMany`, because most
    // links come from bookings and have no invitation at all.
    await tx.invitation.updateMany({
      where: { teacherId: input.teacherId, email },
      data: { status: 'declined', respondedAt: new Date() },
    });

    // The block is what actually holds, invitation or not.
    await tx.teacherBlock.upsert({
      where: { teacherId_email: { teacherId: input.teacherId, email } },
      update: {},
      create: { teacherId: input.teacherId, email },
    });
  });
  return { ok: true };
}

/**
 * A student's own booking is acceptance, so it resolves whatever
 * invitation state stood between them and this teacher — including a
 * `declined` tombstone. That asymmetry is the design: the tombstone is
 * permanent from the teacher's side and always reversible from the
 * student's, which is what keeps declining from being a trap while still
 * denying the teacher a re-invite.
 *
 * `updateMany`, not `update`: most bookings have no invitation row at all
 * and a zero-row update must not throw.
 */
export async function resolveInvitationOnLink(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; studentEmail: string },
): Promise<void> {
  // Lowercased again, and for the same reason each time: invitation emails
  // are always stored lowercase, `Student.email` and `Account.email` never
  // are. Miss it here and a booking silently fails to clear the declined
  // tombstone — so the student's only route back to a teacher they declined
  // stops working, which is the one escape hatch the whole decline design
  // rests on.
  const email = input.studentEmail.toLowerCase();

  // Task 6c moved the block into its own table, and the block is the thing
  // that actually stands between them — so clearing it is what makes booking
  // the student's route back. Updating the invitation alone would leave the
  // pair connected on paper and severed in practice: linked, but every future
  // invitation from this teacher still undeliverable.
  await tx.teacherBlock.deleteMany({ where: { teacherId: input.teacherId, email } });

  // `status: { not: 'accepted' }` so an already-accepted row's `respondedAt`
  // — the original acceptance moment — is left alone. Nothing reads it yet,
  // which is exactly why this is worth getting right now: every later
  // booking would otherwise silently overwrite it, and the drift wouldn't
  // surface until something finally does read it.
  await tx.invitation.updateMany({
    where: { teacherId: input.teacherId, email, status: { not: 'accepted' } },
    data: { status: 'accepted', respondedAt: new Date() },
  });
}
