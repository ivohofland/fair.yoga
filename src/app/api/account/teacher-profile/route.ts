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
import { teacherProfileSchema } from '@/lib/schemas';
import {
  SIGNUP_TICKET_COOKIE,
  consumeSignupTicket,
  mintSignupTicket,
  clearSignupTicketCookie,
  setSignupTicketCookie,
  createSession,
  setSessionCookie,
} from '@/lib/auth';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';

/**
 * Creates the teacher profile (#385). Two authorizations, one route: the
 * signup ticket (new signup, no account yet) or a live session (an existing
 * account adding the teacher hat — the mirror of `student-profile`'s "join
 * as a student").
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Body validation runs before the ticket is ever consumed: a malformed
  // request must not burn a real, single-use ticket for nothing — losing it
  // to a typo is exactly the bad-first-interaction `signup-ticket.ts`'s own
  // TTL rationale exists to avoid.
  const parsed = await parseBody(request, teacherProfileSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, bio, pageSlug, defaultTimezone } = parsed.data;

  const ticketToken = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
  const ticketEmail = ticketToken ? await consumeSignupTicket(prisma, ticketToken) : null;

  let accountId: string | null = null;
  let email: string;

  if (ticketEmail) {
    email = ticketEmail;
  } else {
    const session = await requireSession(request);
    if (isErrorResponse(session)) return session;
    if (session.teacherId) {
      return respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER');
    }
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    accountId = session.accountId;
    email = account.email;
  }

  try {
    const teacher = await prisma.teacher.create({
      data: {
        firstName, lastName, email, bio, pageSlug,
        defaultCurrency: 'EUR',
        // Falls back to Amsterdam only when the browser couldn't report one
        // (#258) — never an unconditional overwrite of what Task 1's schema
        // carries through from detection.
        defaultTimezone: defaultTimezone ?? 'Europe/Amsterdam',
        // A ticket has no account yet; a session has one already.
        ...(accountId ? { accountId } : { account: { create: { email } } }),
      },
    });

    const response = respondOk({ teacherId: teacher.id }, 201);
    if (ticketEmail) {
      const sessionToken = await createSession(prisma, teacher.accountId);
      setSessionCookie(response.headers, sessionToken);
      clearSignupTicketCookie(response.headers);
    }
    return response;
  } catch (err) {
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      const conflict = respondError('Page address already in use', 409, 'SLUG_TAKEN');
      // The ticket that got us here is already spent (single-use, consumed
      // above) — without a fresh one the client's cookie now names a dead
      // token, and a retry (even with a different slug) falls through to
      // `requireSession` and 401s. Safe to re-mint: `ticketEmail` only
      // exists because THIS request already consumed a ticket proving
      // ownership of it, so minting another proves nothing new. Session-authed
      // callers have no ticket to replace, so this is skipped for them.
      if (ticketEmail) {
        const freshTicket = await mintSignupTicket(prisma, ticketEmail);
        setSignupTicketCookie(conflict.headers, freshTicket);
      }
      return conflict;
    }
    if (isUniqueConflictOn(err, ['email']) || isUniqueConflictOn(err, ['accountId'])) {
      return respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // code-less 409, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher profile create hit a unique constraint that is neither the slug, the email nor the account key',
      );
      throw new Error('teacher profile create: unrecognised unique constraint');
    }
    throw err;
  }
});
