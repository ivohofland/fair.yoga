/**
 * What a student's own act does to the invitation state standing between
 * them and one teacher (#166).
 *
 * One function, in its own module, and the reason is structural rather than
 * tidiness. `invitations.ts` imports `withdrawWaitingEntriesForTeacher` from
 * `waitlist.ts` (an unlink must withdraw the queue positions that would let
 * the teacher reach back through), and `waitlist.ts` needs this function
 * (joining a waitlist is a consenting act, and this is what answers one).
 * Those two imports together are a cycle. It happened to work — both edges
 * resolve to hoisted function declarations, so neither is read at module
 * evaluation time — but it is a cycle that survives on a property nobody
 * states, and the correction that moved link creation to `addToWaitlist`
 * would have thickened it rather than left it alone.
 *
 * So this file imports from neither, and both import from it. Keep it that
 * way: an import of `invitations.ts` or `waitlist.ts` from in here restores
 * the cycle through the back door.
 */

import type { Prisma } from '@prisma/client';
import { requireNormalised } from '@/lib/schemas';

/**
 * A student's own act is acceptance — of whatever there was still left to
 * accept. A booking or a waitlist join resolves a `pending` invitation only
 * when it was the act that put the student on this teacher's roster; someone
 * already on the roster has nothing left to consent to, so a `pending` row
 * standing beside a link that already existed is left exactly where it is. A
 * `declined` row is cleared either way, and the `TeacherBlock` with it.
 *
 * The narrowing on `pending` is a security property (#418), and the asymmetry
 * with `declined` below is deliberate rather than an oversight. Both halves
 * turn on rows this file never touches — what `inviteContact` refuses, what
 * `unlinkTeacher` writes, which rows `DELETE /api/invitations/[id]` will
 * remove — so the rule and its derivation live in `docs/data-model.md`
 * (Invitation), not here.
 *
 * What is true of this function, and is why the condition is written the way
 * it is: a `pending` row left alone here never becomes `accepted`, so it never
 * reaches the refusal an `accepted` row on a linked pair gets, and the probe
 * that was waiting on it has nothing to observe. `link-consent.test.ts` drives
 * that sequence end to end, through the real invite path, and fails if this
 * condition is widened again.
 *
 * Call this only from a path where the student themselves is acting toward
 * one named teacher, at this instant. Today that is `POST /api/registrations`
 * (their own booking — the call sits inside the `!isTeacher` branch, so a
 * teacher-initiated roster add never reaches it) and `addToWaitlist`
 * (services/waitlist.ts, reached only through `POST /api/waitlist`, which is
 * `requireStudent` and self-only). `promoteNext` and `claimSpot` deliberately
 * do NOT call this — see their comments. That rule, not the number of sites,
 * is what a new caller has to satisfy.
 *
 * There used to be a second mode here — a `LinkConsent` parameter whose
 * `standing` value resolved only a `pending` invitation — for the one caller
 * whose link was not created by an act of the student's: a waitlist
 * promotion, which fires when the teacher cancels some other registration.
 * That distinction has no referent any more. The link is created where the
 * consent is actually given, and promotion resolves nothing, so every caller
 * of this function is a student acting at this instant. Do not reintroduce
 * the mode: the way to keep a refusal safe is to not call this from
 * something a teacher can trigger, not to weaken what it does when they
 * can't.
 *
 * `linkCreatedNow` is not that mode returning. It carries no claim about the
 * caller's intent — the paragraph above is still the whole of what a caller
 * must satisfy — only the fact of what this transaction's own link write did.
 * Pass exactly what `linkTeacherStudent` (`services/roster-link.ts`) returned
 * for this pair, from this transaction, and do not re-derive it: that value
 * comes off the link's single `INSERT … ON CONFLICT DO NOTHING`, which is the
 * one reading that cannot race. A `findUnique` before the insert can be
 * overtaken by a concurrent writer, and one after it always finds the row.
 *
 * `updateMany`, not `update`: most bookings have no invitation row at all
 * and a zero-row update must not throw.
 */
export async function resolveInvitationOnLink(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; studentEmail: string; linkCreatedNow: boolean },
): Promise<void> {
  // Asserted lowercase again, for the same reason each time: invitation
  // emails are always stored lowercase, and `Student.email` and
  // `Account.email` are too now (`*_email_lowercase_check`, #170). Miss this
  // and a booking silently fails to clear the declined tombstone — so the
  // student's only route back to a teacher they declined stops working,
  // which is the one escape hatch the whole decline design rests on.
  // `requireNormalised` (src/lib/schemas.ts) turns that silent miss into a
  // thrown error instead of letting it happen.
  const email = requireNormalised(input.studentEmail);

  // Task 6c moved the block into its own table, and the block is the thing
  // that actually stands between them — so clearing it is what makes booking
  // the student's route back. Updating the invitation alone would leave the
  // pair connected on paper and severed in practice: linked, but every future
  // invitation from this teacher still undeliverable.
  await tx.teacherBlock.deleteMany({ where: { teacherId: input.teacherId, email } });

  // The two columns of the rule above, written as one `where`. On a link this
  // call created, `{ not: 'accepted' }` — `pending` and `declined` alike. On a
  // link that already stood, `declined` alone: the standing refusal is still
  // the student's to reverse, the `pending` row is no longer theirs to
  // resolve. An already-`accepted` row is excluded under either, so its
  // `respondedAt` — the original acceptance moment — survives. Nothing reads
  // it yet, which is exactly why this is worth getting right now: every later
  // booking would otherwise silently overwrite it, and the drift wouldn't
  // surface until something finally does read it.
  await tx.invitation.updateMany({
    where: {
      teacherId: input.teacherId,
      email,
      status: input.linkCreatedNow ? { not: 'accepted' } : 'declined',
    },
    data: { status: 'accepted', respondedAt: new Date() },
  });
}
