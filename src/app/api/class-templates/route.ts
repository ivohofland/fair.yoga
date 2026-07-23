import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createClassTemplateSchema } from '@/lib/schemas';
import { generateClassInstances } from '@/services/class-generator';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.teacherId },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(templates);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createClassTemplateSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return respondError('Invalid teacher room', 400);
  }

  const template = await prisma.classTemplate.create({
    data: {
      teacherId: session.teacherId,
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

  // The schedule must show the class the moment the template exists —
  // the cron only tops the rolling window up later. Failure is logged,
  // not returned: generation is guaranteed eventually by the cron, and
  // a 500 here would invite retrying a create that already succeeded.
  // The catch is deliberately untestable at HTTP level and load-bearing:
  // do not "simplify" it away.
  try {
    await generateClassInstances(prisma, undefined, session.teacherId);
  } catch (err) {
    // Generation is teacher-wide; templateId names the trigger, not
    // necessarily the failing template.
    log.error(
      { err, teacherId: session.teacherId, templateId: template.id },
      'instance generation after template create failed',
    );
  }

  return respondOk(template, 201);
});
