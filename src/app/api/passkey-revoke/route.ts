import { NextRequest } from 'next/server';
import { respondTyped, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { passkeyRevokeSchema } from '@/lib/schemas';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';
import { revokePasskeyByLink } from '@/services/passkey-revoke';
import { deliverPasskeyRemovedNotice } from '@/services/passkey-notice';

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 20;

/**
 * Redeems a passkey-added email's "This wasn't me" link. Needs no session: the
 * link is the credential, and all it can do is sign the account out, delete
 * its pending sign-in links and remove that one passkey where a pause allows.
 *
 * One answer whether the passkey was removed, was already gone or was kept by
 * a pause, and one refusal for every link that cannot act: an unauthenticated
 * caller learns nothing about the account from the answer. A removal emails the
 * account address once it has committed.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const limit = checkIpRateLimit('passkey-revoke', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'passkey-revoke');
  if (!limit.allowed) return respondRateLimited(limit, 'Too many attempts.');

  const body = await parseBody(request, passkeyRevokeSchema);
  if ('error' in body) return body.error;

  const outcome = await revokePasskeyByLink(prisma, body.data.token);
  switch (outcome.status) {
    case 'revoked':
      if (outcome.removal !== null) deliverPasskeyRemovedNotice(prisma, outcome.removal);
      return respondTyped<{ revoked: true }>({ revoked: true });
    case 'invalid':
      return respondError(
        'This link no longer works. It may have been used already, or it has expired.',
        404,
        'REVOKE_LINK_INVALID',
      );
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled passkey revoke outcome: ${String((unhandled as { status?: unknown }).status)}`);
    }
  }
});
