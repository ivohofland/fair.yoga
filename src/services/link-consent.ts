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
import type { LinkOutcome } from '@/services/roster-link';
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
 * it is: this call leaves such a row exactly as it found it, so nothing on the
 * booking or waitlist path turns it into the `accepted` row a second probe
 * would meet as `ALREADY_LINKED`. `acceptInvitation` would still flip such a
 * row, but nothing puts it in front of the student to accept:
 * `listPendingInvitations` excludes a linked pair's invitation and
 * `notifyInvitee` returns early on a live link, so reaching it means guessing
 * a uuid.
 *
 * `link-consent.test.ts` walks the probe-book-probe sequence against this
 * function directly — the booking half is a call to it, not a real one — and
 * fails if this condition is widened again. The same sequence over a real
 * booking is `src/app/api/registrations/route.test.ts` (the route handler,
 * runnable in a worktree) and `tests/integration/invitations-api.test.ts`
 * (over HTTP).
 *
 * Call this only from a path where the student themselves is acting toward
 * one named teacher, at this instant. A waitlist promotion is not such a
 * path: it fires when someone else's registration goes away, off a request
 * the student made earlier, so it must not resolve anything — and no
 * narrowing of what this function writes would make such a caller safe.
 * Which sites create a roster link, which of them resolve and which abstain,
 * is a census `docs/data-model.md` (Invitation, "What a student's own act
 * resolves") owns and ships the re-derivation command for. That rule, not the
 * number of sites, is what a new caller has to satisfy.
 *
 * `linkOutcome` carries no claim about the caller's intent — the call-site
 * rule above is the whole of what a caller must satisfy — only the fact of
 * what this transaction's own link write did. The union is what stops an
 * unrelated boolean arriving here; it cannot say "from this transaction", so
 * that half is a rule to read rather than a type to satisfy.
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
  input: { teacherId: string; studentEmail: string; linkOutcome: LinkOutcome },
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
      status: input.linkOutcome === 'created' ? { not: 'accepted' } : 'declined',
    },
    data: { status: 'accepted', respondedAt: new Date() },
  });
}
