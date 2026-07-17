import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import {
  autoTransitionToInProgress,
  autoCancelClasses,
  autoCompleteClasses,
} from '@/services/class-transitions';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const [transitioned, cancelled, completed] = await Promise.all([
    autoTransitionToInProgress(prisma),
    autoCancelClasses(prisma),
    autoCompleteClasses(prisma),
  ]);

  return respondOk({
    transitioned,
    cancelled,
    completed,
  });
});
