import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondTyped,
  respondUnchanged,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { removeFromWaitlist } from '@/services/waitlist';

/** The body of a leave, applied or unchanged. */
type LeaveBody = { message: string };

const ENTRY_GONE = 'This waitlist spot no longer exists.';

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const entry = await prisma.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return respondError(ENTRY_GONE, 404, 'NOT_FOUND');

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

  // Three answers when the removal writes nothing. The entry read above can be
  // GONE by now — a concurrent `deleteStudentAccount` deletes every
  // `WaitlistEntry` the student holds — and not-found is honest for that. It
  // can be `removed`, which is what leaving writes: the goal holds. Or it can
  // be closed some other way — a stale render when a class starts and
  // `closeQueueOnStart` (#216) flips the row to `expired` — and denying a row
  // the student is looking at would be false, so that is a refusal and a
  // refresh.
  const result = await removeFromWaitlist(prisma, entry.classId, entry.studentId);
  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') {
      return respondError(ENTRY_GONE, 404, 'NOT_FOUND');
    }
    if (result.status === 'removed') {
      return respondUnchanged<LeaveBody>({ message: 'Removed from waitlist' });
    }
    return respondError(
      'That waitlist spot is no longer active — refresh to see the latest.',
      409,
      'WAITLIST_ENTRY_INACTIVE',
    );
  }

  return respondTyped<LeaveBody>({ message: 'Removed from waitlist' });
});
