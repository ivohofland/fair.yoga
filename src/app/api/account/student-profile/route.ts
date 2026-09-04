import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { respondOk, respondError, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { studentProfileSchema } from '@/lib/schemas';
import { DEFAULT_INCOME_TIER } from '@/lib/tiers';
import {
  clearSignupTicketCookie,
  createSession,
  setSessionCookie,
  resolveTicketOnlyProfileAuthorization,
} from '@/lib/auth';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';

/**
 * Creates the student profile (#399). Two authorizations, one route: the
 * signup ticket (new booking-page signup, no account yet) or a live session
 * (an existing account adding the student hat — "join as a student", the
 * mirror of `teacher-profile`'s ticket+session shape).
 * `resolveTicketOnlyProfileAuthorization` applies the resolver's shared
 * ticket-vs-session precedence rule (#428) — see `profile-authorization.ts`.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const outcome = await resolveTicketOnlyProfileAuthorization(
    prisma,
    request,
    'student',
    studentProfileSchema,
  );
  if (!outcome.ok) return outcome.response;
  const authorization = outcome.auth;

  type Authorization =
    | { source: 'ticket'; email: string; firstName: string; lastName: string }
    | { source: 'session'; accountId: string; email: string; firstName: string; lastName: string };
  let auth: Authorization;
  if (authorization.source === 'ticket') {
    auth = {
      source: 'ticket',
      email: authorization.email,
      firstName: authorization.body.firstName,
      lastName: authorization.body.lastName,
    };
  } else {
    const session = authorization.session;
    if (session.studentId) {
      return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
    }
    if (!session.teacherId) {
      return respondError('Account has no profile to copy from', 409, 'NO_PROFILE_SOURCE');
    }
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { id: session.teacherId },
      select: { firstName: true, lastName: true },
    });

    // A teacher may already exist in someone's CRM as an unclaimed contact
    // under this email — claiming that row keeps their history instead of
    // colliding with its unique email.
    const unclaimed = await prisma.student.findFirst({
      where: { email: authorization.email, claimedAt: null },
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
      const claimed = respondOk({ studentId: student.id }, 201);
      if (authorization.staleTicketCookie) clearSignupTicketCookie(claimed.headers);
      return claimed;
    }

    auth = {
      source: 'session',
      accountId: session.accountId,
      email: authorization.email,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
    };
  }

  // `session.studentId` above is the pre-check, and it is a plain read, so a
  // second tap of this button passes it and one of the two loses here.
  // Answering with the pre-check's own code keeps the two paths
  // indistinguishable to the client (#161).
  //
  // On the SESSION path, a double-tap writes the same `accountId` AND the
  // same `email`, so both indexes have a pending entry and Postgres reports
  // whichever it reaches first — the catch below checks `accountId` first
  // but must still recognize an `email` hit as the same benign case.
  // Naming that collision is not an enumeration oracle: the route is
  // authenticated, writing for the caller's own account, and
  // `Account.email @unique` means no other account holds this address, so no
  // foreign row can be the one that collided.
  //
  // The TICKET path has no session and no "caller's own account" — its
  // `email` collision means a DIFFERENT account appeared for this address
  // during the ticket's one-hour window (a real, if narrow, race — not a
  // double-tap), so the catch below answers it separately, with its own
  // message and a log line.
  try {
    const student = await prisma.student.create({
      data: {
        firstName: auth.firstName,
        lastName: auth.lastName,
        email: auth.email,
        incomeTier: DEFAULT_INCOME_TIER,
        claimedAt: new Date(),
        // A ticket has no account yet; a session has one already.
        ...(auth.source === 'session' ? { accountId: auth.accountId } : { account: { create: { email: auth.email } } }),
      },
      select: { id: true, accountId: true },
    });

    const response = respondOk({ studentId: student.id }, 201);
    if (auth.source === 'ticket') {
      // `accountId` types as nullable — the column predates #166 and stays
      // nullable for those rows — but this statement's own nested
      // `account: { create }` just set it, so a null here means the create
      // above silently produced a different row than this one.
      if (!student.accountId) {
        throw new Error('student profile create: ticket-authorized row has no accountId');
      }
      const sessionToken = await createSession(prisma, student.accountId);
      setSessionCookie(response.headers, sessionToken);
      clearSignupTicketCookie(response.headers);
    } else if (authorization.source === 'session' && authorization.staleTicketCookie) {
      clearSignupTicketCookie(response.headers);
    }
    return response;
  } catch (err) {
    if (isUniqueConflictOn(err, ['accountId'])) {
      return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
    }
    if (isUniqueConflictOn(err, ['email'])) {
      if (auth.source === 'ticket') {
        // Not the caller's own account — see the comment above this block.
        // Worth a log line: unlike the session path's double-tap, this is
        // not the benign, expected shape of this collision.
        log.warn(
          {},
          'student profile ticket path lost to an email that gained an account during the ticket window',
        );
        return respondError(
          'This email now has an account. Please sign in and add a student profile.',
          409,
          'ACCOUNT_EXISTS',
        );
      }
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
