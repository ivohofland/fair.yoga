import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, parseBody, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { createStudioClassSchema } from '@/lib/schemas';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClasses = await prisma.studioClass.findMany({
    where: { teacherId: session.teacherId },
    orderBy: { date: 'desc' },
  });

  return respondOk(studioClasses);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudioClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Fields are named rather than spread. The spread was not the vulnerability —
  // Zod strips undeclared keys, so only declared keys ever rode it — but it did
  // make `templateId` and `studentCount` invisible: neither name appeared in
  // this handler, so grepping for them found nothing (#148).
  const studioClass = await prisma.studioClass.create({
    data: {
      teacherId: session.teacherId,
      classType: body.classType,
      date: new Date(body.date),
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      location: body.location,
      hourlyRate: body.hourlyRate,
    },
  });

  return respondOk(studioClass, 201);
});
