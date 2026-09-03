import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import {
  respondOk,
  respondError,
  parseBody,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { studentProfileSchema } from '@/lib/schemas';
import { DEFAULT_INCOME_TIER } from '@/lib/tiers';
import {
  SIGNUP_TICKET_COOKIE,
  peekSignupTicket,
  consumeSignupTicket,
  clearSignupTicketCookie,
  createSession,
  setSessionCookie,
} from '@/lib/auth';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';

/**
 * Creates the student profile (#399). Two authorizations, one route: the
 * signup ticket (new booking-page signup, no account yet) or a live session
 * (an existing account adding the student hat — "join as a student", the
 * mirror of `teacher-profile`'s ticket+session shape).
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const ticketToken = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;

  // Peeked (not consumed) first: whether a body is worth parsing depends on
  // the ticket actually resolving, not merely on the cookie's presence. A
  // stale or expired ticket cookie must fall through to the session path
  // below instead of failing the body parse before `requireSession` ever
  // runs — `magic-link/verify` clears the origin nonce but never this
  // cookie, so a browser can carry a dead ticket alongside a live session.
  // Conditional because the session path has no body at all: `JoinAsStudent`
  // POSTs without one, and `parseBody` opens with `request.json()`, which
  // throws on an empty body.
  const ticketAddress = ticketToken
    ? await peekSignupTicket(prisma, ticketToken, 'student')
    : null;

  let names: { firstName: string; lastName: string } | null = null;
  if (ticketAddress) {
    const parsed = await parseBody(request, studentProfileSchema);
    if ('error' in parsed) return parsed.error;
    names = parsed.data;
  }

  // Consumed (single-use) only after a successful parse, so a typo in the
  // name fields doesn't cost the ticket — `teacher-profile`'s ordering, for
  // its reason: losing a ticket to a typo is a bad first interaction.
  const ticketConsumed =
    ticketAddress && names && ticketToken
      ? (await consumeSignupTicket(prisma, ticketToken, 'student')) !== null
      : false;

  type Authorization =
    | { source: 'ticket'; email: string; firstName: string; lastName: string }
    | { source: 'session'; accountId: string; email: string; firstName: string; lastName: string };
  let auth: Authorization;

  if (ticketConsumed && ticketAddress && names) {
    auth = { source: 'ticket', email: ticketAddress, firstName: names.firstName, lastName: names.lastName };
  } else {
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

    auth = {
      source: 'session',
      accountId: session.accountId,
      email: account.email,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
    };
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
    }
    return response;
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
