import { NextRequest } from 'next/server';
import { verifyPasskeyRegistration, getAndDeleteChallenge } from '@/lib/auth';
import {
  respondOk,
  respondError,
  requireSession,
  requireRecentAuth,
  isErrorResponse,
  parseBody,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { passkeyRegisterVerifySchema } from '@/lib/schemas';
import { deliverPasskeyAddedNotice } from '@/services/passkey-notice';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // Before the challenge is consumed: a session that aged out between the two
  // steps is refused with the challenge still standing.
  const stale = await requireRecentAuth(session);
  if (stale) return stale;

  const parsed = await parseBody(request, passkeyRegisterVerifySchema);
  if ('error' in parsed) return parsed.error;

  const challenge = getAndDeleteChallenge('registration', session.accountId);
  if (!challenge) {
    return respondError(
      'This passkey setup expired. Please try again.',
      400,
      'PASSKEY_CHALLENGE_MISSING',
    );
  }

  const result = await verifyPasskeyRegistration({
    response: parsed.data.response as unknown as RegistrationResponseJSON,
    expectedChallenge: challenge,
  });

  if (!result.verified) {
    return respondError(
      'This passkey could not be verified. Please try again.',
      400,
      'PASSKEY_NOT_VERIFIED',
    );
  }

  const credential = await prisma.passkeyCredential.create({
    data: {
      id: result.credentialId,
      accountId: session.accountId,
      publicKey: Buffer.from(result.publicKey),
      counter: result.counter,
      transports: result.transports,
    },
    select: { createdAt: true },
  });

  deliverPasskeyAddedNotice(prisma, {
    accountId: session.accountId,
    addedAt: credential.createdAt,
    credentialId: result.credentialId,
  });

  return respondOk({ credentialId: result.credentialId });
});
