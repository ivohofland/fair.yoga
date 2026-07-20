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
  const { date, ...rest } = parsed.data;

  const studioClass = await prisma.studioClass.create({
    data: {
      teacherId: session.teacherId,
      date: new Date(date),
      ...rest,
    },
  });

  return respondOk(studioClass, 201);
});
