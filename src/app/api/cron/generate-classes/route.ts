import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { generateClassInstances } from '@/services/class-generator';
import { generateStudioClassInstances } from '@/services/studio-class-generator';
import { createContentionStreaks } from '@/services/generation-contention';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // A fresh tracker each call: a manual run is a one-off, not a tick in the
  // scheduler's series, so it never escalates contention on its own.
  const [classesCreated, studioClassesCreated] = await Promise.all([
    generateClassInstances(prisma, { streaks: createContentionStreaks() }),
    generateStudioClassInstances(prisma, { streaks: createContentionStreaks() }),
  ]);

  return respondOk({
    classesCreated,
    studioClassesCreated,
  });
});
