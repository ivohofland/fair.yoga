import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { unlinkTeacher } from '@/services/invitations';

/**
 * The student's side of #166 that Task 5's accept/decline couldn't cover:
 * severing a link that already exists, without touching the account behind
 * it. See `unlinkTeacher` (src/services/invitations.ts) for what does and
 * does not happen to the Student row, and for its two other writes: any
 * existing `Invitation` for this teacher/email is marked `declined`, and a
 * `TeacherBlock` is written to stop a re-invite (#166 task 6c).
 *
 * `teacherId` travels in the path; `studentId` comes only from the session
 * — never from the request — so there is nothing here for a caller to
 * supply that would sever a link that isn't theirs.
 *
 * One 404 covers both "no such teacher" and "not linked to you": the
 * distinction would tell an unauthenticated-in-that-relationship caller
 * something about who exists on the platform that this route has no reason
 * to disclose.
 */
export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ teacherId: string }> },
) => {
  const { teacherId } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });

  const result = await unlinkTeacher(prisma, {
    teacherId, studentId: session.studentId, accountEmail: account.email,
  });
  if (!result.ok) return respondError('Teacher link not found', 404);

  return respondOk({ teacherId });
});
