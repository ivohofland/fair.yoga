import crypto from 'crypto';
import { NextRequest } from 'next/server';
import {
  generatePasskeyAuthenticationOptions,
  storeChallenge,
} from '@/lib/auth';
import { respondOk, parseBody } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { passkeyAuthOptionsSchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, passkeyAuthOptionsSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  let credentialIds: string[] | undefined;

  if (body.email) {
    // Look up user: Teacher first, then Student
    const teacher = await prisma.teacher.findUnique({
      where: { email: body.email },
    });
    const student = teacher
      ? null
      : await prisma.student.findUnique({ where: { email: body.email } });
    const user = teacher ?? student;

    if (user) {
      const userType = teacher ? 'teacher' : 'student';
      const creds = await prisma.passkeyCredential.findMany({
        where: { userId: user.id, userType },
        select: { id: true },
      });
      credentialIds = creds.map((c) => c.id);
    }
  }

  const options = await generatePasskeyAuthenticationOptions(credentialIds);

  // Store challenge with a random key so the verify endpoint can retrieve it
  const challengeId = crypto.randomBytes(16).toString('hex');
  storeChallenge(challengeId, options.challenge);

  return respondOk({ options, challengeId });
}
