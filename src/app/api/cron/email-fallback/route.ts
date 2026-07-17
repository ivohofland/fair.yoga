import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { processEmailFallback } from '@/services/email-fallback';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const emailsSent = await processEmailFallback(prisma);

  return respondOk({ emailsSent });
});
