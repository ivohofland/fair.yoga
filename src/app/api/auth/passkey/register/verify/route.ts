import { NextRequest } from 'next/server';
import { verifyPasskeyRegistration, getAndDeleteChallenge } from '@/lib/auth';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  parseBody,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { passkeyRegisterVerifySchema } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

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

  await prisma.passkeyCredential.create({
    data: {
      id: result.credentialId,
      accountId: session.accountId,
      publicKey: Buffer.from(result.publicKey),
      counter: result.counter,
      transports: result.transports,
    },
  });

  return respondOk({ credentialId: result.credentialId });
});
