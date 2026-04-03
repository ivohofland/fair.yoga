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

interface VerifyBody {
  response: AuthenticationResponseJSON;
  challengeId: string;
}

export async function POST(request: NextRequest) {
  const body = await parseBody<VerifyBody>(request);
  if (!body?.response || !body.challengeId) {
    return respondError('Response and challengeId are required', 400);
  }

  const challenge = getAndDeleteChallenge(body.challengeId);
  if (!challenge) {
    return respondError('Invalid or expired challenge', 400);
  }

  const credential = await prisma.passkeyCredential.findUnique({
    where: { id: body.response.id },
  });
  if (!credential) {
    return respondError('Credential not found', 400);
  }

  const result = await verifyPasskeyAuthentication({
    response: body.response,
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
    credential.userType === 'teacher' ? '/schedule' : '/bookings';

  const response = respondOk({
    userType: credential.userType,
    userId: credential.userId,
    redirectTo,
  });
  setSessionCookie(response.headers, sessionToken);

  return response;
}
