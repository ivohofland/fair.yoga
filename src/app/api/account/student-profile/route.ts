import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { DEFAULT_INCOME_TIER } from '@/lib/tiers';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';

/**
 * Adds the student side to the signed-in account (the "join as a student"
 * flow on a booking page). Profile attachment happens only here — from an
 * authenticated session, never from an unauthenticated signup route.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (session.studentId) {
    return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
  }
  if (!session.teacherId) {
    return respondError('Account has no profile to copy from', 409, 'NO_PROFILE_SOURCE');
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

  // Scalar accountId, not a relation connect: Prisma splits nested
  // connects into two statements, and the claim/link CHECK constraint
  // requires both fields to change in one.
  if (unclaimed) {
    const student = await prisma.student.update({
      where: { id: unclaimed.id },
      data: { claimedAt: new Date(), accountId: session.accountId },
      select: { id: true },
    });
    return respondOk({ studentId: student.id }, 201);
  }

  // `session.studentId` above is the pre-check, and it is a plain read, so a
  // second tap of this button passes it and one of the two loses here.
  // Answering with the pre-check's own code keeps the two paths
  // indistinguishable to the client (#161).
  //
  // BOTH keys, because a double-tap writes the same `accountId` AND the same
  // `email`, so both indexes have a pending entry and Postgres reports
  // whichever it reaches first. Catching one would pass its test and fail
  // roughly half the time in production.
  //
  // Naming the collision is not an enumeration oracle, and the reason is that
  // this route is authenticated: it writes for the caller's own account, and
  // `Account.email @unique` means no other account holds this address, so no
  // foreign row can be the one that collided. `auth/student-signup` answers a
  // uniform 200 for the opposite reason — it is unauthenticated, so its 409
  // would tell a stranger an address was free.
  try {
    const student = await prisma.student.create({
      data: {
        firstName: teacher.firstName,
        lastName: teacher.lastName,
        email: account.email,
        incomeTier: DEFAULT_INCOME_TIER,
        claimedAt: new Date(),
        accountId: session.accountId,
      },
      select: { id: true },
    });
    return respondOk({ studentId: student.id }, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['accountId']) || isUniqueConflictOn(err, ['email'])) {
      return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // code-less 409, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // `error`, not `warn` as in api-errors.ts's generic P2002 fallback:
      // this route's census of reachable unique keys is exhaustive, so an
      // unrecognised P2002 here means schema drift or a bug, not an
      // ordinary lost race.
      log.error(
        { err, rawTarget: err.meta?.target },
        'student profile create hit a unique constraint that is neither the account nor the email key',
      );
      throw new Error('student profile create: unrecognised unique constraint');
    }
    throw err;
  }
});
