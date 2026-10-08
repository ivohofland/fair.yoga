import { NextRequest } from 'next/server';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { deletePasskey } from '@/services/passkey-credentials';
import { deliverPasskeyRemovedNotice } from '@/services/passkey-notice';

const PASSKEY_GONE = 'That passkey is not on your account.';

/**
 * Not gated on recent sign-in: removing a passkey only takes a way in away,
 * and an owner locked out of one still has the emailed link. Refused while
 * the account's teacher has payments paused (`deletePasskey`). A removal
 * emails the account address once it has committed.
 */
export const DELETE = withErrorHandler(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(request);
    if (isErrorResponse(session)) return session;

    const { id } = await params;
    const outcome = await deletePasskey(prisma, { accountId: session.accountId, credentialId: id });
    switch (outcome.status) {
      case 'deleted':
        deliverPasskeyRemovedNotice(prisma, { accountId: session.accountId, removedAt: outcome.removedAt });
        return respondOk({ deleted: true });
      case 'not_found':
        return respondError(PASSKEY_GONE, 404, 'NOT_FOUND');
      case 'payments_paused':
        return respondError(
          'Passkeys cannot be removed while payments are paused. Resume payments first.',
          409,
          'PASSKEY_REMOVAL_PAUSED',
        );
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled passkey removal outcome: ${String((unhandled as { status?: unknown }).status)}`);
      }
    }
  },
);
