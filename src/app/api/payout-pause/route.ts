import { NextRequest } from 'next/server';
import { respondTyped, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { payoutPauseSchema } from '@/lib/schemas';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';
import { pausePayments } from '@/services/payout-pause';

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 20;

/**
 * Redeems a payout-change email's "This wasn't me" link. Needs no session: the
 * link is the credential, and all it can do is pause.
 *
 * One refusal for every link that cannot pause, and a second link while
 * paused answers like the first: an unauthenticated caller must not learn the
 * pause state from the answer.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const limit = checkIpRateLimit('payout-pause', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'payout-pause');
  if (!limit.allowed) return respondRateLimited(limit, 'Too many attempts.');

  const body = await parseBody(request, payoutPauseSchema);
  if ('error' in body) return body.error;

  const outcome = await pausePayments(prisma, body.data.token);
  switch (outcome.status) {
    case 'paused':
      return respondTyped<{ paused: true }>({ paused: true });
    case 'invalid':
      return respondError(
        'This link no longer works. It may have been used already, or it has expired.',
        404,
        'PAUSE_LINK_INVALID',
      );
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled pause outcome: ${String((unhandled as { status?: unknown }).status)}`);
    }
  }
});
