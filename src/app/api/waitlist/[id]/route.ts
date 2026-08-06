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
    const cls = await prisma.class.findUnique({ where: { id: entry.classId } });
    if (!cls || cls.teacherId !== session.teacherId) {
      return respondError('Access denied', 403);
    }
  }

  // The entry read above can be gone by the time the removal runs — a
  // concurrent `deleteStudentAccount` deletes every `WaitlistEntry` the
  // student holds. That used to reach the client as a bare 500 (Prisma
  // `P2025`, which `classifyApiError` has no branch for). The same 404 the
  // pre-read already returns is the honest answer: whichever way it went, the
  // entry is not there.
  const result = await removeFromWaitlist(prisma, entry.classId, entry.studentId);
  if (!result.ok) return respondError('Waitlist entry not found', 404);

  return respondOk({ message: 'Removed from waitlist' });
});
