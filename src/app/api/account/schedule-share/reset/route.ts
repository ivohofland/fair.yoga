import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireTeacher, isErrorResponse, respondError, respondTyped, withErrorHandler } from '@/lib/api-utils';
import { resetScheduleShareKey, ScheduleShareOffError, type ScheduleShareState } from '@/services/schedule-share';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  try {
    return respondTyped<ScheduleShareState>(await resetScheduleShareKey(prisma, session.teacherId));
  } catch (error) {
    if (error instanceof ScheduleShareOffError) {
      return respondError('Sharing is off, so there is no link to reset.', 409, 'SCHEDULE_SHARE_OFF');
    }
    throw error;
  }
});
