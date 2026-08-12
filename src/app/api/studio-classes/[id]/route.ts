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
