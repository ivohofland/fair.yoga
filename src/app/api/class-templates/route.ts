import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { createClassTemplateSchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.userId },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(templates);
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createClassTemplateSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
    return respondError('Invalid teacher room', 400);
  }

  const template = await prisma.classTemplate.create({
    data: {
      teacherId: session.userId,
      teacherRoomId: body.teacherRoomId,
      classType: body.classType,
      description: body.description,
      dayOfWeek: body.dayOfWeek,
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      roomCost: body.roomCost,
      minRate: body.minRate,
      targetRate: body.targetRate,
      minStudents: body.minStudents,
      maxStudents: body.maxStudents,
      cancelDeadline: body.cancelDeadline,
      autoCancelCheck: body.autoCancelCheck,
    },
  });

  return respondOk(template, 201);
}
