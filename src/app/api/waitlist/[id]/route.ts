import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { removeFromWaitlist } from '@/services/waitlist';

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const entry = await prisma.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return respondError('Waitlist entry not found', 404);

  // Only the student themselves or the class teacher can remove
  const isOwnEntry = entry.studentId === session.studentId;
  if (!isOwnEntry) {
    if (!session.teacherId) return respondError('Access denied', 403);
    const cls = await prisma.class.findUnique({
      where: { id: entry.classId },
      include: { calendarEntry: { select: { teacherId: true } } },
    });
    if (!cls || cls.calendarEntry.teacherId !== session.teacherId) {
      return respondError('Access denied', 403);
    }
  }

  // Two refusals, two answers. The entry read above can be GONE by the time the
  // removal runs — a concurrent `deleteStudentAccount` deletes every
  // `WaitlistEntry` the student holds — and 404 is honest for that; it also
  // replaced the bare 500 Prisma's `P2025` used to fall through to.
  //
  // But it can equally still be there and no longer theirs to leave, which is
  // what a stale render produces every time a class starts with this page open:
  // `closeQueueOnStart` (#216) flips the row to `expired`, and `NOT_FOUND` for
  // that denies the existence of a row the student is looking at and will find
  // again in their own data export. 409 and a refresh, not a denial.
  const result = await removeFromWaitlist(prisma, entry.classId, entry.studentId);
  if (!result.ok) {
    return result.reason === 'NOT_FOUND'
      ? respondError('Waitlist entry not found', 404)
      : respondError('That waitlist spot is no longer active — refresh to see the latest.', 409);
  }

  return respondOk({ message: 'Removed from waitlist' });
});
