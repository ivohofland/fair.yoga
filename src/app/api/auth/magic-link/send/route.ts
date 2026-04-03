import { NextRequest } from 'next/server';
import { generateMagicLinkToken } from '@/lib/auth';
import { respondOk, parseBody } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { sendMagicLinkEmail } from '@/lib/email';
import { magicLinkSendSchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, magicLinkSendSchema);
  if ('error' in parsed) return parsed.error;
  const { email } = parsed.data;

  // Look up user in Teacher table first, then Student
  const teacher = await prisma.teacher.findUnique({ where: { email } });
  const user = teacher ?? (await prisma.student.findUnique({ where: { email } }));

  if (user) {
    const token = await generateMagicLinkToken(prisma, email);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const magicLinkUrl = `${baseUrl}/verify?token=${token}`;
    await sendMagicLinkEmail(email, magicLinkUrl);
  }

  // Always return 200 to prevent email enumeration
  return respondOk({ message: 'If an account exists, a magic link has been sent.' });
}
