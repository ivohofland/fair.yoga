import { NextRequest } from 'next/server';
import { verifyPasskeyRegistration, getAndDeleteChallenge } from '@/lib/auth';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  parseBody,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { passkeyRegisterVerifySchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, passkeyRegisterVerifySchema);
  if ('error' in parsed) return parsed.error;

  const challenge = getAndDeleteChallenge(session.userId);
  if (!challenge) {
    return respondError('No pending registration challenge', 400);
  }

  const result = await verifyPasskeyRegistration({
    response: parsed.data.response as unknown as RegistrationResponseJSON,
    expectedChallenge: challenge,
  });

  if (!result.verified) {
    return respondError('Registration verification failed', 400);
  }

  await prisma.passkeyCredential.create({
    data: {
      id: result.credentialId,
      userId: session.userId,
      userType: session.userType,
      publicKey: Buffer.from(result.publicKey),
      counter: result.counter,
      transports: result.transports,
    },
  });

  return respondOk({ credentialId: result.credentialId });
}
