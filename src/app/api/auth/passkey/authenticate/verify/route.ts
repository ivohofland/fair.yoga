import { NextRequest } from 'next/server';
import {
  verifyPasskeyAuthentication,
  getAndDeleteChallenge,
  createSession,
  setSessionCookie,
  clearSignupTicketCookie,
} from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { passkeyAuthVerifySchema, TEACHER_PROFILE_PATH } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const parsed = await parseBody(request, passkeyAuthVerifySchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  const challenge = getAndDeleteChallenge('authentication', body.challengeId);
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

  await prisma.passkeyCredential.update({
    where: { id: credential.id },
    data: { counter: result.newCounter },
  });

  const sessionToken = await createSession(prisma, credential.accountId);
  const account = await prisma.account.findUnique({
    where: { id: credential.accountId },
    select: { teacher: { select: { deletedAt: true } } },
  });
  const hasTeacherProfile = account?.teacher != null && !account.teacher.deletedAt;
  const fallback = hasTeacherProfile ? '/schedule' : '/bookings';
  // Prefer the caller's destination (booking flow) — schema-validated to a
  // relative path — over the role default; dual-role accounts default to
  // the teacher home. One destination is refused rather than honoured
  // (#439, the guard `magic-link/verify` got in #431): the teacher profile
  // form, for an account that already has a live teacher profile. That
  // page's own first line would bounce such a browser to `/schedule`
  // anyway. Scoped to `hasTeacherProfile`, not to the destination alone —
  // a student-only account's second-hat flow still reaches this path.
  const bouncedTeacherForm = body.redirect === TEACHER_PROFILE_PATH && hasTeacherProfile;
  const redirectTo = body.redirect && !bouncedTeacherForm ? body.redirect : fallback;

  const apiResponse = respondOk({
    accountId: credential.accountId,
    redirectTo,
  });
  setSessionCookie(apiResponse.headers, sessionToken);
  // A browser that just received a session has no legitimate reason to keep
  // carrying a ticket cookie forward.
  clearSignupTicketCookie(apiResponse.headers);

  return apiResponse;
});
