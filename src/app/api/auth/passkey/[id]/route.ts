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

const PASSKEY_GONE = 'That passkey is not on your account.';

/**
 * Not gated on recent sign-in: removing a passkey only takes a way in away,
 * and an owner locked out of one still has the emailed link.
 */
export const DELETE = withErrorHandler(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(request);
    if (isErrorResponse(session)) return session;

    const { id } = await params;
    const deleted = await deletePasskey(prisma, { accountId: session.accountId, credentialId: id });
    if (!deleted) return respondError(PASSKEY_GONE, 404, 'NOT_FOUND');

    return respondOk({ deleted: true });
  },
);
