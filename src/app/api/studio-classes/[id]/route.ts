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
import { updateStudioClassSchema } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isRecordNotFound } from '@/lib/api-errors';
import { log } from '@/lib/log';
import {
  studioClassDeletability,
  STUDIO_CLASS_REGENERATES_MESSAGE,
  STUDIO_CLASS_REGENERATES_CODE,
} from '@/services/studio-class-deletion';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: { template: true },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.teacherId !== session.teacherId) return respondError('Access denied', 403);

  return respondOk(studioClass);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({ where: { id } });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.teacherId !== session.teacherId) return respondError('Access denied', 403);

  const parsed = await parseBody(request, updateStudioClassSchema);
  if ('error' in parsed) return parsed.error;

  if (Object.keys(parsed.data).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const { cancelledAt, ...rest } = parsed.data;
  const updateData: Record<string, unknown> = { ...rest };
  if (cancelledAt !== undefined) {
    updateData.cancelledAt = cancelledAt ? new Date(cancelledAt) : null;
  }

  // `StudioClass_teacher_slot_unique` is (teacherId, date, startTime) WHERE
  // cancelledAt IS NULL (#196). `updateStudioClassSchema` has no `date`, but
  // that still leaves two ways this write re-enters the partial index and
  // collides with another live row at this teacher's (date, startTime):
  // changing `startTime` alone, or clearing `cancelledAt` back to null on a
  // previously cancelled class.
  try {
    const updated = await prisma.studioClass.update({
      where: { id },
      data: updateData,
    });
    return respondOk(updated);
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      return respondError(
        'You already have a studio class at that date and time.',
        409,
        'DUPLICATE_STUDIO_SLOT',
      );
    }
    throw err;
  }
});

/**
 * Remove a studio class outright (issue 279). The policy lives in
 * `studio-class-deletion.ts`; this handler is the thin wrapper CLAUDE.md asks
 * for, and its gate order matches the `GET` and `PUT` above.
 *
 * NO CHECK-TO-DELETE RACE TO BACKSTOP, DELIBERATELY, and this is where the
 * obvious wrong edit is: `room-deletion.ts` is the model for this file and it
 * carries an FK backstop, so copying one here looks like diligence. There is
 * nothing to back stop. Neither disjunct of the predicate can flip
 * `removable → not removable`: `templateId` is written once at creation, and a
 * class whose start has passed cannot un-pass it. The archive door's
 * `deleteMany` is keyed on a concrete `templateId` and filters
 * `cancelledAt: null` with `date: { gt: today }`
 * (`studio-class-template-lifecycle.ts:1262`, `:664`), so it can match neither
 * a manual row nor a past one. The only real race is a second click, and
 * `isRecordNotFound` answers it the way `DELETE /api/waitlist/[id]` answers
 * its own — as never having had the row.
 */
export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    select: { teacherId: true, templateId: true, date: true, startTime: true },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.teacherId !== session.teacherId) return respondError('Access denied', 403);

  const verdict = studioClassDeletability(studioClass, new Date(), session.defaultTimezone);
  if (!verdict.deletable) {
    log.info(
      { studioClassId: id, teacherId: session.teacherId, templateId: studioClass.templateId },
      'studio class removal refused: the sweep would create it again',
    );
    return respondError(STUDIO_CLASS_REGENERATES_MESSAGE, 409, STUDIO_CLASS_REGENERATES_CODE);
  }

  try {
    await prisma.studioClass.delete({ where: { id } });
  } catch (err) {
    if (isRecordNotFound(err)) return respondError('Studio class not found', 404);
    throw err;
  }

  // The only record this removal leaves, and deliberately the only one — see
  // the spec's §6.4. The app has no audit-log table, `withdrawnCount` exists
  // because an ARCHIVE removes rows the teacher never sees, and a `deletedAt`
  // column would re-create the tombstone removal exists to clear.
  log.info(
    { studioClassId: id, teacherId: session.teacherId, templateId: studioClass.templateId },
    'studio class removed',
  );
  return respondOk({ deleted: true });
});
