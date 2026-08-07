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
import { isRecordNotFound } from '@/lib/api-errors';
import { requireNormalised } from '@/lib/schemas';

export type InviteRefusal =
  | 'ALREADY_INVITED'
  | 'ALREADY_LINKED'
  | 'DECLINED'
  | 'CONTACT_CHANGED';

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

/**
 * `ALREADY_INVITED` names the way out, the other two do not, and that
 * asymmetry is the point (F4, #166 review). A teacher whose invitation email
 * silently failed to send meets this refusal when they try again, and on its
 * own it reads as a closed door — while the door is in fact open: `DELETE
 * /api/invitations/[id]` refuses only `declined` rows, so a pending
 * invitation can be removed and re-sent. The recovery existed and was simply
 * undiscoverable. There is no resend button yet; when one lands, this
 * sentence is the thing to repoint at it.
 *
 * One sentence, and it stays one: the first draft of it ran to two and
 * became the longest error string in the app — roughly three wrapped lines
 * in a phone-width form slot, which is not the voice of this project. The
 * recovery is the part that has to survive an edit; the throat-clearing
 * around it is not.
 *
 * `ALREADY_LINKED` and `DECLINED` get no such sentence because neither has
 * one: the first is a person already on the roster (nothing to recover), the
 * second is a tombstone the invitee wrote, and re-inviting past it is exactly
 * what it exists to prevent.
 *
 * `CONTACT_CHANGED` exists so that the two races below are not reported as
 * `DECLINED` (M3, #166 re-review). Both are transient and neither is the
 * invitee's doing — saying "this person declined your invitation" about
 * someone who did not is a false accusation the teacher has no way to check.
 * It names the recovery for the same reason `ALREADY_INVITED` does: a retry
 * genuinely works, and a refusal that does not say so reads as a wall.
 */
export const REFUSAL_MESSAGES: Record<InviteRefusal, string> = {
  ALREADY_INVITED:
    'You have already invited this person — remove the contact to invite them again.',
  ALREADY_LINKED: 'This person is already one of your students.',
  DECLINED: 'This person declined your invitation.',
  CONTACT_CHANGED: 'This contact changed while you were sending — reload and try again.',
};

/**
 * Is this address on this teacher's roster right now?
 *
 * The one question `ALREADY_LINKED` is allowed to be an answer to (F8, #166
 * review). It used to be asked two different ways: `Invitation.status ===
 * 'accepted'` on the row-exists path, and this pair of queries on the
 * no-row path. Those two disagree the moment a link is deleted without the
 * invitation being touched — which is exactly what erasing a student does —
 * and the `status` reading is the one that lies.
 *
 * `false` for "no Student row" and for "Student row, no link" alike, and
 * that is the property, not an implementation detail: the caller must not be
 * able to tell those two apart, or it becomes the account-enumeration oracle
 * the old `POST /api/students` was.
 *
 * A plain, case-SENSITIVE `findUnique`, safe because both sides are
 * guaranteed lowercase now (#170): this `email` argument already passed
 * through `requireNormalised` at the caller (`inviteContact` below), and
 * `Student.email` can only ever hold lowercase —
 * `Student_email_lowercase_check` rejects anything else at rest. Neither
 * guarantee existed when this ran a case-folding `findFirst` instead; both
 * do now, which is what makes the plain unique-index lookup below correct
 * instead of merely convenient.
 */
async function hasRosterLink(
  db: PrismaClient,
  teacherId: string,
  email: string,
): Promise<boolean> {
  const student = await db.student.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!student) return false;

  const link = await db.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId: student.id } },
    select: { id: true },
  });
  return link !== null;
}

/**
 * Create a CRM contact and invite its owner — or, when an answered
 * invitation has outlived the link it created, return that row to `pending`
 * and invite them again.
 *
 * The security property lives in what this function does NOT branch on.
 * Every refusal below is about a row THIS teacher owns — their own
 * invitation, their own roster link — so answering is not a disclosure.
 * Nothing else is consulted. In particular there is no "does a Student
 * row exist for this address" branch, which is what made the old route an
 * account-enumeration oracle: 200 meant taken, 201 meant free.
 * `hasRosterLink` above is answerable only about this teacher's own roster,
 * which is what keeps calling it safe. Do not add a branch on whether a
 * Student row was found.
 *
 * One residual channel is knowingly left open: the "Student exists but is not
 * on this teacher's roster" path issues one extra query, so it is marginally
 * slower than the path where no Student row exists. That is outside the
 * property this function claims — identical status, identical body, identical
 * side effects — and closing it would mean issuing dummy queries to flatten
 * the timing, which is not worth the contortion at this threat level.
 *
 * The block check below runs unconditionally, after the invitation row is
 * already written — a blocked and a fresh address run the exact same query
 * sequence, differing only in the `delivered` value neither response ever
 * carries on the wire. The revive path and the create path share that tail
 * on purpose: a second block check written for the revive would be a second
 * place to get it subtly wrong, and re-inviting a blocked address has to
 * stay as silent as inviting one for the first time.
 */
export async function inviteContact(
  db: PrismaClient,
  input: { teacherId: string; email: string; firstName: string; lastName: string },
): Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }> {
  const { teacherId, firstName, lastName } = input;

  // The CRM is the one place in this app where one human types ANOTHER
  // human's address, and a case slip here fails silently: the teacher sees a
  // pending invitation, the student never sees anything. The column is
  // lowercase by construction — `createInvitationSchema` normalises `email`
  // at HTTP ingress via `emailField` (src/lib/schemas.ts) — so this asserts
  // that precondition rather than normalising a second time. See
  // `requireNormalised`'s own docblock for why an assertion, not a
  // re-normalisation.
  const email = requireNormalised(input.email);

  const existing = await db.invitation.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { id: true, status: true },
  });

  // Every Invitation row left standing is one the teacher typed themselves
  // — the block that used to live in here has moved to `TeacherBlock` — so
  // a 409 here tells them nothing they did not already have, and silence
  // would be cruelty rather than protection.
  if (existing?.status === 'declined') return { ok: false, reason: 'DECLINED' };
  if (existing?.status === 'pending') return { ok: false, reason: 'ALREADY_INVITED' };

  // What is left is an `accepted` row, or no row at all — and both turn on
  // the same question, asked the same way (F8, #166 review).
  //
  // `accepted` used to answer `ALREADY_LINKED` on the strength of the status
  // alone. Erasing a student deletes their `TeacherStudent` rows and leaves
  // `Invitation` untouched, so that answer became a permanent lie: the
  // teacher was told "already one of your students" about someone not on
  // their roster, on the one row shape they can neither delete (it is not
  // declined, but it is not re-invitable either) nor edit their way out of.
  // The `@@unique([teacherId, email])` key means the way back is this row,
  // returned to `pending`.
  //
  // No row at all is the same question with a different history: a link with
  // no invitation is a student who booked a class instead of being invited.
  if (await hasRosterLink(db, teacherId, email)) {
    return { ok: false, reason: 'ALREADY_LINKED' };
  }

  let invitationId: string;
  if (existing) {
    const revived = await revivePendingInvitation(db, existing.id, { firstName, lastName });
    // The revive matched no row, so the state this function read at the top
    // is gone. Two things can have done that, and neither is the invitee
    // refusing: `unlinkTeacher` wrote a `declined` tombstone under us, or
    // `DELETE /api/invitations/[id]` removed the row from the teacher's own
    // second tab (it refuses only `declined` rows, so an `accepted` one goes
    // freely). Both are transient — a retry takes the create path or meets a
    // real tombstone and says so — so the honest answer is "re-read", not an
    // accusation. Reporting `DECLINED` here told the teacher that a person
    // who had not declined had (M3, #166 re-review).
    if (revived === null) return { ok: false, reason: 'CONTACT_CHANGED' };
    invitationId = revived;
  } else {
    const created = await db.invitation.create({
      data: { teacherId, email, firstName, lastName },
      select: { id: true },
    });
    invitationId = created.id;
  }

  // A block makes this invitation undeliverable, not un-creatable. The row
  // is real, the teacher sees it, edits it, archives it — everything behaves
  // exactly as it does for an address that was never blocked, which is the
  // point. Only delivery is withheld. See `delivered` on InviteResult.
  //
  // Shared by both paths above, so a re-invite of a blocked address is as
  // silent as a first invite of one: same status, same body, same `id` key,
  // and the difference lives only in `delivered`, which never reaches the
  // wire.
  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { id: true },
  });

  return { ok: true, value: { id: invitationId, delivered: blocked === null } };
}

/**
 * Return an `accepted` invitation to `pending` so its teacher can invite
 * that address again (F8, #166 review). Returns the row's id, or `null` if
 * the row stopped being `accepted` under us.
 *
 * `respondedAt: null` is not tidiness — `Invitation_responded_at_status_check`
 * (prisma/migrations/…_invitation_check_constraints) binds it to `status`,
 * so a revive that left the old acceptance timestamp standing would be
 * rejected by Postgres.
 *
 * The names are rewritten and `isArchived` cleared because this is an
 * invitation the teacher is sending now: they typed a name into the form,
 * and a contact that reappeared only in the archive would look like the
 * request did nothing.
 *
 * `updateMany` scoped to `status: 'accepted'`, rather than `update` by id,
 * for one race: `unlinkTeacher` writes `declined` + a `TeacherBlock` in a
 * single transaction, and it can commit between this function's caller
 * reading the row and this write — a window two awaited queries wide, since
 * `hasRosterLink` runs inside it. An unscoped update would flip that fresh
 * tombstone back to `pending` — and `PUT`/`DELETE /api/invitations/[id]`
 * both refuse to touch a declined row precisely because it is meant to be
 * permanent, so the flip would hand the teacher back the delete the
 * tombstone exists to deny. `invitations.revive.test.ts` drives that
 * interleaving deterministically and dies when the scope is removed.
 *
 * A zero count does NOT mean exactly one thing, and an earlier version of
 * this comment claiming it did is what let the caller answer `DECLINED` for
 * it (M3, #166 re-review). `unlinkTeacher` is not the only writer that can
 * move this row: `DELETE /api/invitations/[id]` refuses only `declined`
 * rows, so the teacher's own second tab can delete an `accepted` one
 * outright, and then this update matches nothing with no tombstone anywhere
 * and nobody having declined. Hence `CONTACT_CHANGED` at the call site — the
 * one honest thing that covers both.
 */
async function revivePendingInvitation(
  db: PrismaClient,
  id: string,
  names: { firstName: string; lastName: string },
): Promise<string | null> {
  const revived = await db.invitation.updateMany({
    where: { id, status: 'accepted' },
    data: { status: 'pending', respondedAt: null, isArchived: false, ...names },
  });
  return revived.count === 0 ? null : id;
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
 * `inviteContact`'s create time, and can go stale before this function runs.
 * The live door is a `TeacherBlock` committed in between: `unlinkTeacher`
 * writes one inside its own transaction, and `POST /api/students` calls this
 * fire-and-forget (below), so the two are genuinely concurrent — the student
 * who unlinks a moment after the teacher clicks Send has a `delivered: true`
 * computed before their block existed. That window is the whole reason this
 * function re-queries `TeacherBlock` itself, below, rather than leaning on
 * the caller's value: the guard travels with the send rather than living
 * only in whichever caller remembers to check it. Keep the caller's own gate
 * too — belt and braces, and it skips a query on the common (unblocked) path.
 *
 * `PUT /api/invitations/[id]` edits `email` on a pending row without
 * recomputing `delivered`, which looks like a second door and is not: PUT
 * does not notify, so a value gone stale there reaches nobody. Named only so
 * the next reader does not go checking it, find it harmless, and conclude
 * the re-check below is redundant.
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
  // Load-bearing for both reads below, `TeacherBlock` and `Student` alike:
  // both are plain, case-SENSITIVE `findUnique`s on columns that can only
  // ever hold lowercase (`TeacherBlock_email_lowercase_check`,
  // `Student_email_lowercase_check`). An un-normalised `input.email` used to
  // be silently lowercased here; now it throws instead of reaching either
  // lookup. Drop the assertion and an invitee address carrying uppercase
  // misses the block entirely — and the send goes out to the exact person
  // who blocked this teacher, which is the channel the block exists to
  // close. `invitations.notify.test.ts` covers both halves: the throw on an
  // un-normalised address, and that a properly-lowercase blocked address
  // still gets no send.
  //
  // Asserted here rather than trusted from the caller, the same way every
  // other email-comparing function in this file does (acceptInvitation,
  // declineInvitation, unlinkTeacher) and the one next door
  // (resolveInvitationOnLink, services/link-consent.ts).
  const email = requireNormalised(input.email);

  // Structural, not comment-enforced (F3, #166 review): re-check the block
  // here instead of trusting the caller's `delivered` to still be fresh.
  // See this function's docblock for why `delivered` can go stale.
  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId: input.teacherId, email } },
    select: { id: true },
  });
  if (blocked) return;

  // A plain, case-SENSITIVE `findUnique` — safe for the same reason
  // `hasRosterLink`'s is (`Student_email_lowercase_check` plus the
  // `requireNormalised` above) — but with a worse consequence if that ever
  // stops holding: a miss here does not merely skip the in-app notification,
  // it falls through to the plain-email branch below — which bypasses
  // `Student.emailNotifications` entirely and tells an existing account
  // holder to go and sign up.
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
 * `accountEmail` is asserted lowercase, not lowercased — for the same reason
 * every other email match in this file now is: `Invitation.email` and
 * `TeacherBlock.email` are written lowercase by construction, and
 * `Account.email` is too now (`Account_email_lowercase_check`, #170), so
 * `requireNormalised` (src/lib/schemas.ts) has a real precondition to check
 * rather than a difference to paper over.
 *
 * `deletedAt: null` is the other half of `acceptInvitation`'s own liveness
 * check (F7, #166 review). Erasure (`deleteTeacherAccount`, services/gdpr.ts)
 * deletes every `TeacherStudent` row and renames the teacher to "Deleted
 * Teacher", but it leaves `Invitation` rows standing — so without this
 * filter a student is offered a card inviting them to connect with an
 * account that no longer exists, naming a person called "Deleted Teacher".
 * This is the primary gate for that, the same way the block exclusion above
 * is the primary gate for a block.
 */
export async function listPendingInvitations(
  db: PrismaClient,
  input: { accountEmail: string },
): Promise<Array<{ id: string; teacher: { firstName: string; lastName: string } }>> {
  const email = requireNormalised(input.accountEmail);
  return db.invitation.findMany({
    where: {
      email,
      status: 'pending',
      teacher: { deletedAt: null, teacherBlocks: { none: { email } } },
    },
    select: { id: true, teacher: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Rolls back `acceptInvitation`'s transaction when the invitation is no
 * longer pending. A plain `return false` would commit the `TeacherStudent`
 * upsert taken above it — including, on the create path, a genuine
 * `INSERT` — so the link would exist for an invitation nobody accepted.
 * Only a throw, caught outside `$transaction`, rolls that write back with
 * everything else. `invitations-lock-order.test.ts` proves the negative
 * directly: a NOT_PENDING refusal leaves no `TeacherStudent` row even though
 * the upsert already ran by the time this fires.
 *
 * Declared ABOVE `acceptInvitation`'s docblock, not between it and the
 * function. It sat between them until #174's four-specialist review, which
 * meant TypeScript attached that 46-line docblock to this error class
 * instead: every hover, every go-to-definition and every doc tool showed
 * `acceptInvitation`'s ownership-gate reasoning as the description of
 * `NotPendingError`, while `acceptInvitation` itself showed nothing.
 * `declineInvitation` below cross-references that docblock by name, so the
 * text people were sent to was attached to the wrong symbol.
 */
class NotPendingError extends Error {}

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
 * `accountEmail` is asserted lowercase, not lowercased: `Invitation.email` is
 * written lowercase by `inviteContact` above and by `PUT /api/invitations/[id]`,
 * and `Account.email` is normalised at HTTP ingress (`emailField`,
 * src/lib/schemas.ts) and enforced lowercase by
 * `Account_email_lowercase_check` (#170) — so `requireNormalised` has a real
 * invariant to check, not a difference to paper over.
 *
 * The block check below is defence in depth, not the primary gate — the
 * student-side pending query (Task 11) already excludes a blocked pair, so
 * this id should never reach here for one. But the id travels in a URL, not
 * a secret, and this whole function exists because that can't be trusted.
 * It returns the same `NOT_FOUND` as an unknown id, not a distinct code: a
 * distinct code would tell a probing caller that a block exists, which is
 * the exact bit `inviteContact` above withholds.
 *
 * `teacher: { deletedAt: null }` is in the `where` for the same structural
 * reason the email match is (F7, #166 review): a condition the write depends
 * on belongs in the query, not in a check after the read. Erasure
 * (`deleteTeacherAccount`, services/gdpr.ts) deletes every `TeacherStudent`
 * row this teacher had, but it does not touch `Invitation` — so an
 * invitation sent before the erasure is still `pending`, and without this
 * the `upsert` below RECREATES a link erasure deleted, against an account
 * that no longer exists. Every reader that surfaces a teacher to another
 * person filters this (`(public)/[slug]`, `(public)/[slug]/book/[classId]`,
 * `validateSession`, `payment-reminders`); this one did not.
 *
 * Also `NOT_FOUND`, not a code of its own. The student loses nothing by it:
 * `listPendingInvitations` above already drops the card, so a refresh is
 * the whole explanation, and the only way to reach this branch at all is a
 * page held open across the erasure. Against that, a distinct code is a new
 * bit on a student-facing route that anyone holding a guessed id could read
 * — and this route's whole design is that an id, on its own, tells a caller
 * nothing. Keeping every "there is nothing here for you" answer identical is
 * worth more than naming this one.
 */
export async function acceptInvitation(
  db: PrismaClient,
  input: { invitationId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
  const email = requireNormalised(input.accountEmail);
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email, teacher: { deletedAt: null } },
    select: { id: true, teacherId: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };

  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId: invitation.teacherId, email } },
    select: { id: true },
  });
  if (blocked) return { ok: false, reason: 'NOT_FOUND' };

  const accepted = await db.$transaction(async (tx) => {
    // `TeacherStudent` BEFORE `Invitation`. `unlinkTeacher`,
    // `deleteStudentAccount` and `deleteTeacherAccount` all take these two
    // rows in that order; this function alone took them the other way
    // round, which is a genuine cycle on paper — two transactions, each
    // holding what the other wants next.
    //
    // It does not currently deadlock, and the reason is not that the old
    // order was safe: `upsert({ where, update: {}, create: {...} })`
    // compiles to three plain, non-locking `SELECT`s when the row already
    // exists (confirmed by query log, #174 task 7), not the atomic
    // `INSERT ... ON CONFLICT DO UPDATE` a non-empty `update` produces — so
    // the upsert below has never actually asked Postgres for the row lock
    // the cycle needs. That is an accident of how Prisma compiles an empty
    // `update` object, not a design decision, and it is one real column
    // away from vanishing: give this `update` a single field (an
    // `updatedAt`, a bookkeeping flag) and the atomic path returns, the
    // lock is taken, the cycle re-forms, and Postgres starts answering
    // `40P01 deadlock detected` — surfaced as a 500 by `withErrorHandler` —
    // with no warning anywhere that the edit did that. Reordering removes
    // the dependency on that accident rather than leaving it as the only
    // thing standing between this function and a deadlock the next
    // contributor who "tidies" `update: {}` would reintroduce silently. See
    // `docs/lock-order.md`, and the mechanism-pinning tests in
    // `invitations-lock-order.test.ts` (this directory) that force the
    // atomic path with a synthetic non-empty `update` and show the old order
    // deadlocks under it while this one does not.
    //
    // The cycle is not only hypothetical, either: on a pair with no link yet,
    // this upsert genuinely `INSERT`s, and so does `POST
    // /api/registrations`'s — which upserts `TeacherStudent` and then reaches
    // `Invitation` through `resolveInvitationOnLink`. Postgres makes the
    // second inserter wait on the first's uncommitted tuple, and that wait
    // deadlocks exactly like a row lock. Reproduced against the real function
    // and the route's real statement order, three runs per order: old order
    // `accept: REJECTED 40P01` 3/3, this order no deadlock 3/3
    // (`does not deadlock when a real accept races a real booking on an
    // unlinked pair`). That reproduction needs a handshake to widen a
    // one-round-trip window, so the order itself is pinned separately and
    // unconditionally by `takes TeacherStudent before Invitation, and
    // accepts`.
    //
    // Upserting first is safe to do unconditionally: the link is not the
    // thing being decided. If the `updateMany` below then matches nothing —
    // a concurrent decline or unlink got there first — the transaction
    // rolls back and the upsert goes with it (see `NotPendingError` above
    // for why that has to be a throw rather than a `return false`).
    //
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

    // The pending check lives in this `updateMany`'s `where`, not in a read
    // beforehand — a concurrent accept and decline from the same account
    // (the only account that can ever pass the email match above) would
    // otherwise both pass a separate status read and race to leave a
    // `TeacherStudent` link sitting beside a `declined` invitation.
    const updated = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'accepted', respondedAt: new Date() },
    });
    if (updated.count === 0) throw new NotPendingError();

    return true;
  }).catch((err: unknown) => {
    if (err instanceof NotPendingError) return false;
    throw err;
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
  // Same precondition as `acceptInvitation` above: `accountEmail` and
  // `Invitation.email` must already be lowercase for this match to work.
  const email = requireNormalised(input.accountEmail);
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email },
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

  const unlinked = await db.$transaction(async (tx) => {
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
    // It lives in `waitlist.ts` because it must take the class row's `FOR
    // UPDATE` lock, and that convention belongs with the table it protects.
    // A comment at this exact call site has already gone stale twice for
    // naming which functions in that module do and do not take it — once
    // under #166, again under #174 once `removeFromWaitlist` picked the
    // lock up — so this one names none: see
    // `withdrawWaitingEntriesForTeacher`'s own docblock (`waitlist.ts`,
    // called immediately below) for the current, authoritative account of
    // who locks and why, and for why this call must run before this
    // transaction's other writes — a deadlock question, not a preference.
    await withdrawWaitingEntriesForTeacher(tx, {
      teacherId: input.teacherId,
      studentId: input.studentId,
    });

    // `StudentPrivacy` BEFORE `TeacherStudent` — a correctness requirement,
    // not the order these two used to appear in this function. Both
    // `deleteStudentAccount` and `deleteTeacherAccount` (services/gdpr.ts)
    // take these two rows in that order; this function alone took them the
    // other way round, and unlike the `Invitation`/`TeacherStudent`
    // inversion #174 also fixed, this one is not protected by any accident
    // of how Prisma compiles an upsert: `SILENCED_PRIVACY` below is six real
    // columns, never empty, so this `upsert` always compiles to the atomic
    // `INSERT ... ON CONFLICT DO UPDATE`, which always takes the row lock.
    // Reproduced directly (#174 task 7): a transaction shaped like this
    // function's old order, racing one shaped like `deleteStudentAccount`'s,
    // deadlocked with Postgres `40P01 deadlock detected` on the first run —
    // no synthetic non-empty payload needed, the real code was already
    // exploitable. See `docs/lock-order.md`.
    //
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

    // Delete-by-id, from a `findUnique` taken BEFORE this transaction opened.
    // If a concurrent `deleteStudentAccount` or `deleteTeacherAccount`
    // (`gdpr.ts`) removed and committed that same row in the gap, this id
    // points at nothing and Prisma throws `P2025` — which used to fall
    // through `classifyApiError` to a bare 500 on a student-facing route.
    // `docs/lock-order.md` ("Related, but not a lock-order issue") records
    // the race itself, which has two shapes and does not depend on lock order
    // at all: the erasure can commit before this transaction even opens, or
    // while this transaction sits blocked on a lock it holds. The catch below
    // translates both into the answer this route already models.
    await tx.teacherStudent.delete({ where: { id: link.id } });

    // Asserted lowercase for the same reason `acceptInvitation` asserts it:
    // `Invitation.email` and `TeacherBlock.email` are always stored
    // lowercase, and `Account.email` is too now
    // (`Account_email_lowercase_check`, #170). A raw address here would miss
    // an existing invitation row and write the block under a different
    // casing than `inviteContact` looks it up by — `requireNormalised`
    // (src/lib/schemas.ts) turns that silent miss into a thrown error.
    const email = requireNormalised(input.accountEmail);

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
    return true;
  }).catch((err: unknown) => {
    // A concurrent erasure deleted the link out from under this transaction.
    // `NOT_LINKED` is what `DELETE /api/teacher-links/[teacherId]` turns into
    // a 404, which is the same answer the caller would have got a moment
    // earlier from the `findUnique` above: there is no link. Losing that race
    // should not read differently from never having had the row.
    //
    // No sentinel-error class is needed here, unlike `acceptInvitation`'s
    // `NotPendingError` above. That one exists because OUR code decides to
    // give up mid-transaction, where a bare `return` would commit the writes
    // taken before it. Here Prisma throws, which already aborts the
    // transaction and rolls back the withdrawal and the privacy write with
    // it — this catch is outside `$transaction`, so all it does is translate
    // an outcome that has already happened.
    if (isRecordNotFound(err)) return false;
    throw err;
  });
  if (!unlinked) return { ok: false, reason: 'NOT_LINKED' };
  return { ok: true };
}
