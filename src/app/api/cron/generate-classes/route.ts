import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { generateClassInstances } from '@/services/class-generator';
import { generateStudioClassInstances } from '@/services/studio-class-generator';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const [classesCreated, studioClassesCreated] = await Promise.all([
    generateClassInstances(prisma),
    generateStudioClassInstances(prisma),
  ]);

  return respondOk({
    classesCreated,
    studioClassesCreated,
  });
});
