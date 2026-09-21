import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodeWithStatus } from '@/lib/api-error-codes';
import { claimWaitlistSchema } from '@/lib/schemas';
import { claimSpot, WaitlistPromotionError } from '@/services/waitlist';

/** The code each claim refusal is sent with. The message is the service's own. */
const CLAIM_REFUSAL_CODE = {
  class_cancelled: 'CLASS_CANCELLED',
  class_not_open: 'CLASS_NOT_BOOKABLE',
  window_frozen: 'WAITLIST_FROZEN',
  wrong_window: 'CLAIM_NOT_OPEN',
  class_full: 'SPOT_TAKEN',
  entry_not_waiting: 'NOT_ON_WAITLIST',
} as const satisfies Record<WaitlistPromotionError['reason'], CodeWithStatus<409>>;

/**
 * An unchanged claim's body. The class, not an entry: the seat the claimant
 * already holds may have no waitlist entry behind it.
 */
type UnchangedClaim = { classId: string };

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
    const result = await claimSpot(prisma, parsed.data.classId, session.studentId);
    switch (result.outcome) {
      case 'claimed':
        return respondOk(result.entry, 201);
      case 'already_registered':
        return respondUnchanged<UnchangedClaim>({ classId: parsed.data.classId });
      case 'class_not_found':
        return respondError('This class no longer exists.', 404, 'NOT_FOUND');
      default: {
        const unreachable: never = result;
        throw new Error(`unhandled claim outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  } catch (err) {
    if (err instanceof WaitlistPromotionError) {
      return respondError(err.message, 409, CLAIM_REFUSAL_CODE[err.reason]);
    }
    throw err;
  }
});
