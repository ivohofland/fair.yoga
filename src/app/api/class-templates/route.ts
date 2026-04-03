import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.userId },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(templates);
}

interface CreateClassTemplateBody {
  teacherRoomId: string;
  classType: string;
  description?: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  cancelDeadline?: 'HOURS_48' | 'HOURS_24' | 'HOURS_12' | 'HOURS_6';
  autoCancelCheck?: 'HOURS_4' | 'HOURS_2' | 'HOURS_1';
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<CreateClassTemplateBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const {
    teacherRoomId,
    classType,
    dayOfWeek,
    startTime,
    durationMinutes,
    roomCost,
    minRate,
    targetRate,
    minStudents,
    maxStudents,
  } = body;

  if (
    !teacherRoomId ||
    !classType ||
    dayOfWeek === undefined ||
    !startTime ||
    !durationMinutes ||
    roomCost === undefined ||
    minRate === undefined ||
    targetRate === undefined ||
    !minStudents ||
    !maxStudents
  ) {
    return respondError(
      'Missing required fields: teacherRoomId, classType, dayOfWeek, startTime, durationMinutes, roomCost, minRate, targetRate, minStudents, maxStudents',
      400,
    );
  }

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
    return respondError('Invalid teacher room', 400);
  }

  const template = await prisma.classTemplate.create({
    data: {
      teacherId: session.userId,
      teacherRoomId,
      classType,
      description: body.description,
      dayOfWeek,
      startTime,
      durationMinutes,
      roomCost,
      minRate,
      targetRate,
      minStudents,
      maxStudents,
      cancelDeadline: body.cancelDeadline,
      autoCancelCheck: body.autoCancelCheck,
    },
  });

  return respondOk(template, 201);
}
