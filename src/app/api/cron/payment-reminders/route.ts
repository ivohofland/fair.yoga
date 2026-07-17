import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { processPaymentReminders } from '@/services/payment-reminders';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const result = await processPaymentReminders(prisma);

  return respondOk(result);
});
