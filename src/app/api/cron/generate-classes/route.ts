import { NextRequest } from 'next/server';
import { respondOk } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { generateClassInstances } from '@/services/class-generator';
import { generateStudioClassInstances } from '@/services/studio-class-generator';

export async function POST(request: NextRequest) {
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
}
