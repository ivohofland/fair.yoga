import { NextRequest } from 'next/server';
import {
  verifyPasskeyAuthentication,
  getAndDeleteChallenge,
  createSession,
  setSessionCookie,
} from '@/lib/auth';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { passkeyAuthVerifySchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, passkeyAuthVerifySchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  const challenge = getAndDeleteChallenge(body.challengeId);
  if (!challenge) {
    return respondError('Invalid or expired challenge', 400);
  }

  const response = body.response as unknown as AuthenticationResponseJSON;

  const credential = await prisma.passkeyCredential.findUnique({
    where: { id: response.id },
  });
  if (!credential) {
    return respondError('Credential not found', 400);
  }

  const result = await verifyPasskeyAuthentication({
    response,
    expectedChallenge: challenge,
    credentialPublicKey: new Uint8Array(credential.publicKey),
    credentialCounter: Number(credential.counter),
  });

  if (!result.verified) {
    return respondError('Authentication verification failed', 400);
  }

  // Update credential counter
  await prisma.passkeyCredential.update({
    where: { id: credential.id },
    data: { counter: result.newCounter },
  });

  // Create session
  const sessionToken = await createSession(
    prisma,
    credential.userId,
    credential.userType
  );
  const redirectTo =
    credential.userType === 'teacher' ? '/' : '/bookings';

  const apiResponse = respondOk({
    userType: credential.userType,
    userId: credential.userId,
    redirectTo,
  });
  setSessionCookie(apiResponse.headers, sessionToken);

  return apiResponse;
}
