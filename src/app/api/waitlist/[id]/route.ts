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
  if (session.userType === 'student' && entry.studentId !== session.userId) {
    return respondError('Access denied', 403);
  }

  if (session.userType === 'teacher') {
    const cls = await prisma.class.findUnique({ where: { id: entry.classId } });
    if (!cls || cls.teacherId !== session.userId) {
      return respondError('Access denied', 403);
    }
  }

  await removeFromWaitlist(prisma, entry.classId, entry.studentId);
  return respondOk({ message: 'Removed from waitlist' });
});
