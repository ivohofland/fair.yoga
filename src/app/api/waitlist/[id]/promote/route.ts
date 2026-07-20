import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { promoteNext, WaitlistPromotionError } from '@/services/waitlist';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const entry = await prisma.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return respondError('Waitlist entry not found', 404);

  // Verify teacher owns the class
  const cls = await prisma.class.findUnique({ where: { id: entry.classId } });
  if (!cls || cls.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  try {
    // Promote the entry the teacher actually chose — not the queue head.
    const promoted = await promoteNext(prisma, entry.classId, { entryId: id });
    return respondOk(promoted);
  } catch (err) {
    if (err instanceof WaitlistPromotionError) {
      return respondError(err.message, 409);
    }
    throw err;
  }
});
