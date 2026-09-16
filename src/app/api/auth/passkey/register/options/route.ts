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
import { liveProfile } from '@/lib/live-profile';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // The passkey belongs to the account; name it after whichever LIVE profile
  // exists (teacher first — the account email is the same either way). The
  // `deletedAt` filters are not decoration: an erased profile's name is
  // anonymised, and this display name lands permanently in the viewer's own
  // credential manager.
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: {
      email: true,
      teachers: {
        where: { deletedAt: null },
        select: { id: true, deletedAt: true, firstName: true, lastName: true },
      },
      students: {
        where: { deletedAt: null },
        select: { id: true, deletedAt: true, firstName: true, lastName: true },
      },
    },
  });
  if (!account) {
    return respondError('Account not found', 404);
  }
  // Both calls run unconditionally: `liveProfile` throws on two live rows of
  // one kind, and `??`'s short-circuit would skip the student-side call (and
  // its assertion) whenever a live teacher exists.
  const liveTeacher = liveProfile(account.teachers);
  const liveStudent = liveProfile(account.students);
  const profile = liveTeacher ?? liveStudent;
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
