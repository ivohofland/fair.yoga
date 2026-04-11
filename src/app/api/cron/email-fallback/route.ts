import { NextRequest } from 'next/server';
import { respondOk } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { processEmailFallback } from '@/services/email-fallback';

export async function POST(request: NextRequest) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const emailsSent = await processEmailFallback(prisma);

  return respondOk({ emailsSent });
}
