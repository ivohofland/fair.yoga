import { NextRequest } from 'next/server';
import { generatePasskeyRegistrationOptions } from '@/lib/auth';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // Look up user to get name and email
  const user =
    session.userType === 'teacher'
      ? await prisma.teacher.findUnique({ where: { id: session.userId } })
      : await prisma.student.findUnique({ where: { id: session.userId } });

  if (!user) {
    // Session references a user that no longer exists
    return respondError('User not found', 404);
  }

  // Get existing passkey credentials for this user
  const existingCreds = await prisma.passkeyCredential.findMany({
    where: { userId: session.userId, userType: session.userType },
    select: { id: true },
  });

  const options = await generatePasskeyRegistrationOptions({
    userId: session.userId,
    userType: session.userType,
    userName: user.email,
    userDisplayName: `${user.firstName} ${user.lastName}`,
    existingCredentialIds: existingCreds.map((c) => c.id),
  });

  return respondOk(options);
}
