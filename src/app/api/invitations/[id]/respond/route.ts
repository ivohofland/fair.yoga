import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
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
    if (result.reason === 'NOT_FOUND') return respondError('Invitation not found', 404);
    return respondError('This invitation has already been answered', 409, 'ALREADY_ANSWERED');
  }
  return respondOk({ id });
});
