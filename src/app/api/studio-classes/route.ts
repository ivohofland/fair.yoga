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
import { createStudioClassSchema } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClasses = await prisma.studioClass.findMany({
    where: { teacherId: session.teacherId },
    orderBy: { date: 'desc' },
  });

  return respondOk(
    studioClasses.map((sc) => ({ ...sc, startTime: timeToHHmm(sc.startTime) })),
  );
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
  try {
    const studioClass = await prisma.studioClass.create({
      data: {
        teacherId: session.teacherId,
        classType: body.classType,
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
        location: body.location,
        hourlyRate: body.hourlyRate,
      },
    });
    return respondOk({ ...studioClass, startTime: timeToHHmm(studioClass.startTime) }, 201);
  } catch (err) {
    // The slot key, not the template key. `@@unique([templateId, date])`
    // cannot raise P2002 here — this create never sets `templateId` (a
    // manually logged class never has one), so it is NULL, and Postgres
    // treats NULLs as distinct. The column-list match still matters: it is
    // what would tell the two keys apart the day this route starts
    // accepting a `templateId`, not what tells them apart today.
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      return respondError(
        'You already have a studio class at that date and time.',
        409,
        'DUPLICATE_STUDIO_SLOT',
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
        'studio class create refused: the class family holds that slot',
      );
      return respondError(
        'You already have a class at that date and time.',
        409,
        'CROSS_FAMILY_CLASS_SLOT',
      );
    }
    throw err;
  }
});
