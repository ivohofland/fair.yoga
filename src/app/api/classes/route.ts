import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { createClassSchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const where: Record<string, unknown> = { teacherId: session.userId };
  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    where.date = dateFilter;
  }

  const classes = await prisma.class.findMany({
    where,
    include: {
      _count: { select: { registrations: true } },
    },
    orderBy: { date: 'asc' },
  });

  return respondOk(classes);
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
    return respondError('Invalid teacher room', 400);
  }

  const cls = await prisma.class.create({
    data: {
      teacherId: session.userId,
      teacherRoomId: body.teacherRoomId,
      classType: body.classType,
      description: body.description ?? null,
      date: new Date(body.date),
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      roomCost: body.roomCost,
      minRate: body.minRate,
      targetRate: body.targetRate,
      minStudents: body.minStudents,
      maxStudents: body.maxStudents,
      cancelDeadline: body.cancelDeadline as never ?? undefined,
      autoCancelCheck: body.autoCancelCheck as never ?? undefined,
      templateId: body.templateId ?? null,
      status: 'draft',
    },
  });

  return respondOk(cls, 201);
}
