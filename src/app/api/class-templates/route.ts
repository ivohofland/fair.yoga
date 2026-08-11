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
import { generateInstancesForTemplate } from '@/services/class-generator';

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

  // Atomic: a generation failure rolls the template create back rather than
  // leaving a template that produces no classes. Failure propagates (500).
  const template = await prisma.$transaction(async (tx) => {
    const created = await tx.classTemplate.create({
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
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    const generation = await generateInstancesForTemplate(tx, created);
    return { created, generation };
  });

  const { teacher, ...created } = template.created;
  void teacher;

  // The atomicity note above guarantees a generation *failure* rolls the
  // template back. It does not cover generation *succeeding* having created
  // nothing, which #196's slot pre-check made an ordinary outcome: a teacher
  // creating a second template on a day and time they already occupy gets a
  // live template whose every candidate date is taken. That used to be
  // impossible, so 201 with no counts was a complete answer; it no longer is.
  // The same counts the PATCH `active` arm carries. **The create form does not
  // render them yet** — it calls `router.push` on 201 and reads nothing from
  // this body (`template-form.tsx`), so today these fields serve the operator
  // via the generator's `log.warn` and any client that asks. Emitting them is
  // what makes the teacher-facing half a copy change rather than a plumbing
  // one; see the note at that push.
  return respondOk(
    {
      ...created,
      added: template.generation.created,
      blockedByCancelled: template.generation.skipped.filter(
        (s) => s.reason === 'blocked_by_cancelled',
      ).length,
      slotTaken: template.generation.skipped.filter((s) => s.reason === 'slot_taken').length,
    },
    201,
  );
});
