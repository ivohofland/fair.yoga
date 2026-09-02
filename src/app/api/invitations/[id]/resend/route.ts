import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { checkStudentWriteLimit, respondRateLimited } from '@/lib/rate-limit';
import { deliverInvitation } from '@/services/invitations';
import { log } from '@/lib/log';
import { ownedInvitation, NOT_FOUND, DECLINED } from '../shared';

/**
 * Resend a pending invitation to its current address (#173) — the recovery
 * from a send that never went out, or from a teacher who just corrected a
 * typo and wants the corrected address mailed. `PUT /api/invitations/[id]`
 * still does not notify (see `notifyInvitee`'s docblock, services/
 * invitations.ts); this route is the actual send.
 *
 * The marker write below (`lastNotifiedAt`/`lastNotifiedEmail`) is
 * unconditional — written before `deliverInvitation` is even called, and
 * regardless of whether a `TeacherBlock` ends up withholding the actual
 * send. If it were written only on a successful, unblocked dispatch, a
 * blocked contact's "last invited" display would never advance while every
 * otherwise-identical unblocked one does — a second, silent way for a
 * teacher to learn a specific student blocked them, exactly what
 * `TeacherBlock` exists to prevent from surfacing (see `inviteContact`'s own
 * docblock, services/invitations.ts, for the same property on the create
 * path).
 *
 * No CAS on the `status === 'pending'` check below: a decline landing in
 * the gap between the read and the write could let a stale send through,
 * but `notifyInvitee` has never checked `Invitation.status`, only
 * `TeacherBlock` — so this exact race already exists on `POST /api/students`
 * today (a decline landing between `inviteContact`'s write and its own
 * already-scheduled fire-and-forget dispatch sends the same way). Not a new
 * gap this route opens.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Same bucket `POST /api/students` spends (src/lib/rate-limit.ts) — both
  // cause an email to go to an arbitrary address, so they share one ceiling
  // rather than each getting their own.
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation resend refused: rate limit exceeded');
    return respondRateLimited(limit, 'Too many invitations.');
  }

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return NOT_FOUND();

  if (invitation.status === 'declined') return DECLINED();
  if (invitation.status !== 'pending') {
    // Unreachable from the UI today — the contact detail page redirects
    // away from an accepted invitation before a Resend button could ever
    // render — but the id travels in a URL, not a secret, so a direct call
    // still needs an honest answer rather than a 404 that pretends the row
    // doesn't exist.
    return respondError('This invitation is no longer pending.', 409, 'NOT_PENDING');
  }

  // Unconditional — see this route's own docblock above for why this must
  // never depend on whether `TeacherBlock` withholds the send below.
  //
  // `updateMany`, not `update`: the ownership read above and this write are
  // two separate statements, so a concurrent delete of this row in that gap
  // (DELETE /api/invitations/[id] from another tab) would make a plain
  // `update` throw P2025 — which `classifyApiError` has no branch for and
  // falls through to a bare 500 (src/lib/api-errors.ts) instead of the 404
  // this route already answers for the same row being gone. A zero-count
  // match means exactly that: the row is gone, and 404 is the honest
  // answer.
  const updated = await prisma.invitation.updateMany({
    where: { id },
    data: { lastNotifiedAt: new Date(), lastNotifiedEmail: invitation.email },
  });
  if (updated.count === 0) return NOT_FOUND();

  // Fire-and-forget, same shape as `POST /api/students` — this route's
  // response must not vary in status or latency with whether the address is
  // registered, blocked, or unknown.
  void deliverInvitation(prisma, session.teacherId, invitation.email).catch((err) => {
    log.error(
      { err, teacherId: session.teacherId, invitationId: id },
      'failed to resend invitation',
    );
  });

  return respondOk({ id });
});
