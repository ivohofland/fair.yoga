import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { listAnnouncementAudienceStudents } from '@/services/announcements';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  const students = await listAnnouncementAudienceStudents(prisma, session.teacherId);
  return respondOk({ students });
});
