import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { isErrorResponse, parseBody, requireSession, respondError, respondTyped, respondUnchanged, withErrorHandler } from '@/lib/api-utils';
import { checkRateLimit, rateLimitKey, respondRateLimited } from '@/lib/rate-limit';
import { pushSubscriptionSchema, pushUnsubscribeSchema } from '@/lib/schemas';
import { formatIssues } from '@/lib/validation-message';
import { isP256PublicKey } from '@/lib/push/encrypt';
import { removePushSubscription, savePushSubscription, type SavePushSubscriptionResult } from '@/services/push-subscriptions';

type SubscriptionSaved = { status: SavePushSubscriptionResult };

const WRITES_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60 * 1000;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;
  const limit = checkRateLimit(rateLimitKey('push-subscriptions', session.accountId), WRITES_PER_WINDOW, WINDOW_MS);
  if (!limit.allowed) return respondRateLimited(limit, 'Too many push changes.');

  const parsed = await parseBody(request, pushSubscriptionSchema);
  if ('error' in parsed) return parsed.error;
  const { endpoint, keys } = parsed.data;

  // A length-valid p256dh can still be off the curve; the schema only checks
  // decoded length, so the curve check happens here, past parseBody.
  if (!isP256PublicKey(keys.p256dh)) {
    return respondError(
      formatIssues([{ path: ['keys', 'p256dh'], message: 'p256dh is not a point on the P-256 curve' }]),
      400,
    );
  }

  const status = await savePushSubscription(prisma, session.accountId, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
  // Same shape either way; `outcome: 'unchanged'` beside it says nothing was written.
  return status === 'unchanged'
    ? respondUnchanged<SubscriptionSaved>({ status })
    : respondTyped<SubscriptionSaved>({ status });
});

export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;
  const limit = checkRateLimit(rateLimitKey('push-subscriptions', session.accountId), WRITES_PER_WINDOW, WINDOW_MS);
  if (!limit.allowed) return respondRateLimited(limit, 'Too many push changes.');

  const parsed = await parseBody(request, pushUnsubscribeSchema);
  if ('error' in parsed) return parsed.error;

  const outcome = await removePushSubscription(prisma, session.accountId, parsed.data.endpoint);
  // A missing row and another account's row answer alike: the endpoint is an
  // unguessable secret, so the answer tells the caller nothing it lacks.
  return outcome === 'removed'
    ? respondTyped<{ removed: boolean }>({ removed: true })
    : respondUnchanged<{ removed: boolean }>({ removed: false });
});
