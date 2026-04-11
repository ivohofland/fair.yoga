import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, parseBody, isErrorResponse } from '@/lib/api-utils';
import { createStudioClassSchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClasses = await prisma.studioClass.findMany({
    where: { teacherId: session.userId },
    orderBy: { date: 'desc' },
  });

  return respondOk(studioClasses);
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createStudioClassSchema);
  if ('error' in parsed) return parsed.error;
  const { date, ...rest } = parsed.data;

  const studioClass = await prisma.studioClass.create({
    data: {
      teacherId: session.userId,
      date: new Date(date),
      ...rest,
    },
  });

  return respondOk(studioClass, 201);
}
