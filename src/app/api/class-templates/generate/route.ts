import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { generateClassInstances } from '@/services/class-generator';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Scoped to the calling teacher — the platform-wide sweep belongs to
  // the cron endpoint, not to any authenticated teacher.
  const count = await generateClassInstances(prisma, undefined, session.userId);

  return respondOk({ created: count });
});
