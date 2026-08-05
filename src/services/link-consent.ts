/**
 * What a student's own act does to the invitation state standing between
 * them and one teacher (#166).
 *
 * One function, in its own module, and the reason is structural rather than
 * tidiness. `invitations.ts` imports `withdrawWaitingEntriesForTeacher` from
 * `waitlist.ts` (an unlink must withdraw the queue positions that would let
 * the teacher reach back through), and `waitlist.ts` needs this function
 * (joining a waitlist is a consenting act, so it resolves the invitation).
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

/**
 * A student's own act is acceptance, so it resolves whatever invitation
 * state stood between them and this teacher — `pending` and `declined`
 * alike, and the `TeacherBlock` along with them. Reversing a decline is the
 * escape hatch the whole decline design rests on: permanent from the
 * teacher's side, always reversible from the student's.
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

  // `{ not: 'accepted' }` rather than a list, so a `declined` row flips too
  // — that is the reversal this function exists for. An already-accepted row
  // is excluded, so its `respondedAt` — the original acceptance moment —
  // survives. Nothing reads it yet, which is exactly why this is worth
  // getting right now: every later booking would otherwise silently
  // overwrite it, and the drift wouldn't surface until something finally
  // does read it.
  await tx.invitation.updateMany({
    where: {
      teacherId: input.teacherId,
      email,
      status: { not: 'accepted' },
    },
    data: { status: 'accepted', respondedAt: new Date() },
  });
}
