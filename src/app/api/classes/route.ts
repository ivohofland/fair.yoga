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

interface CreateClassBody {
  teacherRoomId: string;
  classType: string;
  description?: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  cancelDeadline?: string;
  autoCancelCheck?: string;
  templateId?: string;
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<CreateClassBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const {
    teacherRoomId,
    classType,
    description,
    date,
    startTime,
    durationMinutes,
    roomCost,
    minRate,
    targetRate,
    minStudents,
    maxStudents,
    cancelDeadline,
    autoCancelCheck,
    templateId,
  } = body;

  if (!teacherRoomId || !classType || !date || !startTime || durationMinutes == null) {
    return respondError('Missing required fields', 400);
  }

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.userId) {
    return respondError('Invalid teacher room', 400);
  }

  const cls = await prisma.class.create({
    data: {
      teacherId: session.userId,
      teacherRoomId,
      classType,
      description: description ?? null,
      date: new Date(date),
      startTime,
      durationMinutes,
      roomCost,
      minRate,
      targetRate,
      minStudents,
      maxStudents,
      cancelDeadline: cancelDeadline as never ?? undefined,
      autoCancelCheck: autoCancelCheck as never ?? undefined,
      templateId: templateId ?? null,
      status: 'draft',
    },
  });

  return respondOk(cls, 201);
}
