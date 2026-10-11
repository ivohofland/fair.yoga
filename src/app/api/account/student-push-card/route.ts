import { NextRequest } from 'next/server';
import { respondOk, respondUnchanged, requireStudent, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';

/**
 * Records that the student dismissed the push card on `/bookings` (#818), on
 * their `Student` row. The write is conditional on the flag still being false,
 * so a repeat answers unchanged instead of rewriting a row whose goal already
 * holds. Reads no body.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const { count } = await prisma.student.updateMany({
    where: { id: session.studentId, deletedAt: null, dismissedPushCard: false },
    data: { dismissedPushCard: true },
  });

  if (count === 1) return respondOk({ dismissed: true });
  return respondUnchanged<{ dismissed: boolean }>({ dismissed: true });
});
