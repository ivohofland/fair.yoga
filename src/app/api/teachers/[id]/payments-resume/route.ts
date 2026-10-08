import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondTyped, respondUnchanged, respondError, requireTeacher, requireRecentAuth, parseBody, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { paymentsResumeSchema } from '@/lib/schemas';
import { resumePayments } from '@/services/payout-resume';

type Params = { params: Promise<{ id: string }> };

/**
 * Resumes the session teacher's paused payments, confirming the payout
 * details the resume screen showed (`docs/technical-architecture.md`,
 * "Resuming paused payments"). Ownership, then a fresh sign-in, then the
 * service's own order: not paused answers unchanged, then the passkey the
 * pause froze, then the details under the teacher's lock.
 */
export const POST = withErrorHandler(async (request: NextRequest, { params }: Params) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);

  const stale = await requireRecentAuth(session);
  if (stale !== null) return stale;

  const body = await parseBody(request, paymentsResumeSchema);
  if ('error' in body) return body.error;

  const outcome = await resumePayments(prisma, {
    teacherId: id,
    sessionId: session.sessionId,
    fingerprint: body.data.fingerprint,
  });
  switch (outcome.status) {
    case 'resumed':
      return respondTyped<{ resumed: true }>({ resumed: true });
    case 'not_paused':
      return respondUnchanged<{ resumed: true }>({ resumed: true });
    case 'passkey_required':
      return respondError(
        'Sign out, then sign in again with your passkey to resume payments.',
        403,
        'PASSKEY_REQUIRED',
      );
    case 'details_changed':
      return respondError(
        'Your payment details changed since this page loaded. Check them again before resuming.',
        409,
        'PAYOUT_DETAILS_CHANGED',
      );
    case 'teacher_gone':
      log.info({ teacherId: id }, 'payments resume refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled payments resume outcome: ${String((unhandled as { status?: unknown }).status)}`);
    }
  }
});
