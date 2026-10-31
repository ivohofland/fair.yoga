import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  requireTeacher,
  parseBody,
  isErrorResponse,
  respondTyped,
  respondUnchanged,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateScheduleShareSchema } from '@/lib/schemas';
import {
  getScheduleShare,
  enableScheduleShare,
  disableScheduleShare,
  updateScheduleShare,
  type ScheduleShareState,
} from '@/services/schedule-share';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  return respondTyped<ScheduleShareState>(await getScheduleShare(prisma, session.teacherId));
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  const { state, changed } = await enableScheduleShare(prisma, session.teacherId);
  return changed ? respondTyped<ScheduleShareState>(state) : respondUnchanged<ScheduleShareState>(state);
});

export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  const parsed = await parseBody(request, updateScheduleShareSchema);
  if ('error' in parsed) return parsed.error;
  return respondTyped<ScheduleShareState>(await updateScheduleShare(prisma, session.teacherId, parsed.data));
});

export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  const { state, changed } = await disableScheduleShare(prisma, session.teacherId);
  return changed ? respondTyped<ScheduleShareState>(state) : respondUnchanged<ScheduleShareState>(state);
});
