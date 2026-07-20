import { NextRequest } from 'next/server';
import { generatePasskeyRegistrationOptions } from '@/lib/auth';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // The passkey belongs to the account; name it after whichever profile
  // exists (teacher first — the account email is the same either way).
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: {
      email: true,
      teacher: { select: { firstName: true, lastName: true } },
      student: { select: { firstName: true, lastName: true } },
    },
  });
  if (!account) {
    return respondError('Account not found', 404);
  }
  const profile = account.teacher ?? account.student;
  if (!profile) {
    return respondError('Account has no profile', 404);
  }

  const existingCreds = await prisma.passkeyCredential.findMany({
    where: { accountId: session.accountId },
    select: { id: true },
  });

  const options = await generatePasskeyRegistrationOptions({
    accountId: session.accountId,
    userName: account.email,
    userDisplayName: `${profile.firstName} ${profile.lastName}`,
    existingCredentialIds: existingCreds.map((c) => c.id),
  });

  return respondOk(options);
});
