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
import { withdrawWaitingEntriesForTeacher } from './waitlist';
import { createNotification } from './notifications';
import { sendInvitationEmail } from '@/lib/email';

export type InviteRefusal = 'ALREADY_INVITED' | 'ALREADY_LINKED' | 'DECLINED';

export interface InviteResult {
  id: string;
  /**
   * False when a `TeacherBlock` exists for this (teacher, email) pair, true
   * otherwise. Not a detail — it is the field that stops a caller from
   * notifying on every `ok: true`. `POST /api/students` (route.ts) gates its
   * `notifyInvitee` call (below) on `delivered === true`; that gate is one of
   * two things that keep this from becoming a channel back to the exact
   * person who unlinked to get away from this teacher — `notifyInvitee`
   * re-checks `TeacherBlock` itself too (F3, #166 review), since this value
   * is computed once, here, and can go stale by the time a caller reads it.
   * The invitation itself is created either way — only delivery is withheld
   * (#166 task 6c; wired in task 8).
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
  // Matched case-insensitively, because the two sides are normalised
  // differently: `email` above is always lowercase, `Student.email` is
  // stored exactly as typed (`auth/student-signup`, `account/student-profile`).
  // A case-sensitive `findUnique` here misses any student whose stored
  // address carries uppercase, and the miss is silent — the refusal below
  // never fires and the teacher gets a pending invitation for someone
  // already on their roster.
  //
  // `findFirst`, not `findUnique`: an insensitive match cannot use the
  // unique index, so this is a scan of `Student` on a path that runs at most
  // 50 times an hour per teacher (`checkStudentWriteLimit`). Normalising the
  // column on write is the real fix and is filed separately; it is not
  // something to half-do from in here.
  const student = await db.student.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  });
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
 * `delivered` (the caller's gate, above) is computed once, at
 * `inviteContact`'s create time, and can go stale — the only door that can
 * move it after creation is `PUT /api/invitations/[id]`, which edits `email`
 * on a pending row without recomputing it. This function does not lean on
 * the caller having read a fresh value: it re-queries `TeacherBlock` itself,
 * below, so the guard travels with the send rather than living only in
 * whichever caller remembers to check it. Keep the caller's own gate too —
 * belt and braces, and it skips a query on the common (unblocked) path.
 *
 * `POST /api/students` (route.ts) does not await this function — it is
 * called fire-and-forget, after the response's status and body are already
 * fully decided, with its own `.catch` for the rejection path. That is
 * deliberate: whatever this function reads, or how long it takes, must
 * never become the response's status code or its latency. An earlier
 * version of this function was awaited by its caller, and that reopened the
 * exact oracle #166 closed: a Resend outage turned an unregistered
 * address's failure into a 500 while a registered address's plain INSERT
 * still answered 201, and even with Resend healthy, "no work" (blocked) vs.
 * "one SELECT + one INSERT" (registered) vs. "one HTTPS round trip"
 * (stranger) is a timing channel carrying the same bit. A future caller
 * that awaits this — even just to inspect success or failure — reopens it
 * again.
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
  // file does (acceptInvitation, unlinkTeacher) and the one next door
  // (resolveInvitationOnLink, services/link-consent.ts).
  const email = input.email.toLowerCase();

  // Structural, not comment-enforced (F3, #166 review): re-check the block
  // here instead of trusting the caller's `delivered` to still be fresh.
  // See this function's docblock for why `delivered` can go stale.
  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId: input.teacherId, email } },
    select: { id: true },
  });
  if (blocked) return;

  // Case-insensitive for the same reason as `inviteContact`'s own Student
  // lookup, but with a worse consequence: a miss here does not merely skip
  // the in-app notification, it falls through to the plain-email branch
  // below — which bypasses `Student.emailNotifications` entirely and tells
  // an existing account holder to go and sign up.
  const student = await db.student.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
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
  //
  // `/login`, not the invitation page the registered invitee's own fallback
  // email points at (`renderNotificationEmail`, lib/email-templates.ts): a
  // stranger has no account, and the verify flow decides where to land them
  // itself rather than honouring a destination in the link. Not a
  // disclosure — a recipient learns only about their own account, and the
  // teacher sees neither mail. The COPY is what must not branch, and does
  // not: no "welcome back", nothing that says whether fair.yoga already
  // knew this address (see `renderInvitationEmail`'s own test).
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendInvitationEmail(email, input.teacherName, `${baseUrl}/login`);
}

/**
 * A student's own invitations still awaiting a response — the read
 * `(student)/account/privacy/page.tsx` (#166 task 11) renders above the
 * teacher list.
 *
 * The block exclusion below is the PRIMARY gate, not defence in depth:
 * `acceptInvitation`'s own `TeacherBlock` re-check exists only because an
 * id travels in a URL and isn't a secret, on the assumption that a caller
 * never reaches it for a blocked pair by way of this list. Drop this
 * filter and that assumption breaks — a student who walked away from a
 * teacher would see that teacher's invitation reappear here as if nothing
 * had happened.
 *
 * `accountEmail` is lowercased for the same reason every other email match
 * in this file is: `Invitation.email` and `TeacherBlock.email` are always
 * written lowercase, `Account.email` never is.
 */
export async function listPendingInvitations(
  db: PrismaClient,
  input: { accountEmail: string },
): Promise<Array<{ id: string; teacher: { firstName: string; lastName: string } }>> {
  const email = input.accountEmail.toLowerCase();
  return db.invitation.findMany({
    where: {
      email,
      status: 'pending',
      teacher: { teacherBlocks: { none: { email } } },
    },
    select: { id: true, teacher: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
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
 * Every share off, announcements off — the `StudentPrivacy` shape an unlink
 * leaves behind.
 *
 * One object rather than two literals so `upsert`'s `update` and `create`
 * halves cannot drift: a field present in one and missing from the other
 * would leave that share switched on for whichever of the two paths forgot
 * it, with no surface left to switch it off from. Typed as an update input
 * so a misspelled field is a compile error rather than a silently ignored
 * key. `satisfies` rather than an annotation, so the plain boolean literals
 * survive for the `create` half too.
 */
const SILENCED_PRIVACY = {
  shareFullName: false,
  shareEmail: false,
  sharePhone: false,
  shareBirthday: false,
  shareAddress: false,
  receiveComms: false,
} satisfies Prisma.StudentPrivacyUpdateInput;

/**
 * A student severs a teacher link.
 *
 * Two things this deliberately does not do. It does not delete the
 * Student row when the last link goes — the teacher-side DELETE used to,
 * and that behaviour must not survive into a student-facing route. And it
 * does not touch registrations or payments: those are facts, and money may
 * be owed. The teacher keeps seeing them through the registration-scoped
 * surfaces, which is #167's decision applied here.
 *
 * Deleting the link is NOT on its own enough to stop the teacher reaching
 * this student, which is why `StudentPrivacy` is written below — see the
 * comment at that write.
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
    // FIRST, before any write below. A `waiting` entry for one of this
    // teacher's classes is a standing request the student is walking away
    // from along with the link — left in place, it hands the teacher a lever
    // to reach back through: cancel any other registration in that class,
    // `handleSpotFreed` promotes this student off the queue, and the
    // promotion's own `teacherStudent.upsert` restores the link this
    // transaction is deleting. Withdrawing (rather than having `promoteNext`
    // skip a blocked candidate) is deliberate — skipping leaves a zombie
    // entry that keeps trying and occupying a queue position forever;
    // withdrawing matches the principle the rest of this file runs on: the
    // student's most recent act governs. Registrations are untouched, on
    // purpose and unlike this: a registration is a commitment that may carry
    // money owed, a waitlist entry is neither.
    //
    // It lives in `waitlist.ts` because it must take the class lock every
    // other writer of `WaitlistEntry` takes, and it must run before this
    // transaction's other writes — see that function for both, including
    // why the ordering is a deadlock question and not a preference.
    await withdrawWaitingEntriesForTeacher(tx, {
      teacherId: input.teacherId,
      studentId: input.studentId,
    });

    await tx.teacherStudent.delete({ where: { id: link.id } });

    // Deleting the link does not, by itself, stop this teacher reaching the
    // student, and it takes away the control that would.
    //
    // Announcements pick their recipients from `Registration`
    // (`api/announcements/route.ts`), never from `TeacherStudent`, so anyone
    // who booked one class stays a recipient after unlinking. The only
    // opt-out is `StudentPrivacy.receiveComms` — and both the privacy route
    // and the card on `/account/privacy` require a live link, so the mute
    // switch vanishes at the exact moment it is wanted. Meanwhile the
    // teacher's own roster reads this row's `shareFullName` scoped by
    // teacher and registration with no link check at all
    // (`(teacher)/class/[id]/page.tsx`), so a share left switched on keeps
    // disclosing after the student has gone.
    //
    // So the student's last instruction is recorded here, and it outlives
    // the link: silence, and nothing shared. The announcement filter already
    // honours `receiveComms`, and every reader of the share flags already
    // reads this row — no route needs to learn anything new.
    await tx.studentPrivacy.upsert({
      where: {
        studentId_teacherId: { studentId: input.studentId, teacherId: input.teacherId },
      },
      update: SILENCED_PRIVACY,
      create: {
        studentId: input.studentId,
        teacherId: input.teacherId,
        ...SILENCED_PRIVACY,
      },
    });

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
