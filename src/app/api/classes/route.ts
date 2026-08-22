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
import { createClassSchema } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  const where: Record<string, unknown> = { teacherId: session.teacherId };
  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) {
      const fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) return respondError('Invalid "from" date', 400);
      dateFilter.gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) return respondError('Invalid "to" date', 400);
      dateFilter.lte = toDate;
    }
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
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return respondError('Invalid teacher room', 400);
  }

  try {
    const cls = await prisma.class.create({
      data: {
        teacherId: session.teacherId,
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
        cancelDeadline: body.cancelDeadline,
        autoCancelCheck: body.autoCancelCheck,
        status: 'draft',
      },
    });
    return respondOk(cls, 201);
  } catch (err) {
    // The slot key, not the template key. `@@unique([templateId, date])`
    // cannot raise P2002 here — this create never sets `templateId` (a
    // manually created class never has one), so it is NULL, and Postgres
    // treats NULLs as distinct. The column-list match still matters: it is
    // what would tell the two keys apart the day this route starts
    // accepting a `templateId`, not what tells them apart today.
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      return respondError(
        'You already have a class at that date and time.',
        409,
        'DUPLICATE_CLASS_SLOT',
      );
    }
    // The OTHER family holds it (#296) — a `YG001` from the cross-family
    // trigger, which is not a P2002 and so passes straight through the branch
    // above. Same status, deliberately different sentence: that clash is fixed
    // within this family, this one sends the teacher to the other half of
    // their schedule.
    // LOGGED before responding, for the reason the five SERVICE sites now carry:
    // `respondError` does not log and `withErrorHandler` never sees a response
    // that was RETURNED rather than thrown, so catching here is what removes
    // the server-side record. The first fix for this asymmetry moved it rather
    // than closing it — it logged the two service returns and left five route
    // catches silent.
    if (isCrossFamilySlotConflict(err)) {
      log.warn(
        { err, teacherId: session.teacherId },
        'class create refused: the studio family holds that slot',
      );
      return respondError(
        'You already have a studio class at that date and time.',
        409,
        'CROSS_FAMILY_STUDIO_SLOT',
      );
    }
    throw err;
  }
});
