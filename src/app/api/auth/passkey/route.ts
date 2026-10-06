import { NextRequest } from 'next/server';
import { respondOk, requireSession, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { listPasskeys } from '@/services/passkey-credentials';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  return respondOk(await listPasskeys(prisma, session.accountId));
});
