import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { claimWaitlistSchema } from '@/lib/schemas';
import { claimSpot, WaitlistPromotionError } from '@/services/waitlist';

/**
 * First-come-first-claimed: in the final hour before the cancel deadline a
 * freed spot is broadcast to everyone waiting; the first claim lands it.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (!session.studentId) {
    return respondError('Only students can claim waitlist spots', 403);
  }

  const parsed = await parseBody(request, claimWaitlistSchema);
  if ('error' in parsed) return parsed.error;

  try {
    const entry = await claimSpot(prisma, parsed.data.classId, session.studentId);
    return respondOk(entry, 201);
  } catch (err) {
    if (err instanceof WaitlistPromotionError) {
      return respondError(err.message, 409);
    }
    throw err;
  }
});
