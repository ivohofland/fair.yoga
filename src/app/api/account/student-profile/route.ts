import { NextRequest } from 'next/server';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';

/**
 * Adds the student side to the signed-in account (the "join as a student"
 * flow on a booking page). Profile attachment happens only here — from an
 * authenticated session, never from an unauthenticated signup route.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (session.studentId) {
    return respondError('Account already has a student profile', 409);
  }
  if (!session.teacherId) {
    return respondError('Account has no profile to copy from', 409);
  }

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { firstName: true, lastName: true },
  });

  // A teacher may already exist in someone's CRM as an unclaimed contact
  // under this email — claiming that row keeps their history instead of
  // colliding with its unique email.
  const unclaimed = await prisma.student.findFirst({
    where: { email: account.email, claimedAt: null },
    select: { id: true },
  });

  const student = unclaimed
    ? await prisma.student.update({
        where: { id: unclaimed.id },
        data: { claimedAt: new Date(), account: { connect: { id: session.accountId } } },
        select: { id: true },
      })
    : await prisma.student.create({
        data: {
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          email: account.email,
          incomeTier: 3,
          claimedAt: new Date(),
          account: { connect: { id: session.accountId } },
        },
        select: { id: true },
      });

  return respondOk({ studentId: student.id }, 201);
});
