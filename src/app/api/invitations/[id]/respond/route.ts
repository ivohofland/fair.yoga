import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { respondToInvitationSchema } from '@/lib/schemas';
import { acceptInvitation, declineInvitation } from '@/services/invitations';

/**
 * The student's side of #166: accept creates the `TeacherStudent` link,
 * decline does not. Both are authorized by the signed-in account's own
 * email against `Invitation.email` — see `acceptInvitation`/
 * `declineInvitation` (src/services/invitations.ts) for why the id in the
 * URL cannot be the authorization on its own.
 *
 * `requireStudent` gives the 403 for a teacher-only session for free.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, respondToInvitationSchema);
  if ('error' in parsed) return parsed.error;

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });

  const result = parsed.data.response === 'accept'
    ? await acceptInvitation(prisma, {
        invitationId: id, studentId: session.studentId, accountEmail: account.email,
      })
    : await declineInvitation(prisma, { invitationId: id, accountEmail: account.email });

  if (!result.ok) {
    switch (result.reason) {
      case 'NOT_FOUND':
        return respondError('This invitation no longer exists.', 404, 'NOT_FOUND');
      case 'STUDENT_ERASED':
        return respondError('This account has been deleted.', 409, 'STUDENT_ERASED');
      case 'NOT_PENDING':
        return respondError('This invitation has already been answered.', 409, 'ALREADY_ANSWERED');
      case 'CONCURRENT_MODIFICATION':
        return respondError(
          'This invitation was just changed elsewhere. Refresh and try again.',
          409,
          'CONCURRENT_MODIFICATION',
        );
      default: {
        const unhandled: never = result.reason;
        throw new Error(`unhandled invitation response reason: ${unhandled}`);
      }
    }
  }
  if (result.outcome === 'unchanged') return respondUnchanged<{ id: string }>({ id });
  return respondOk({ id });
});
