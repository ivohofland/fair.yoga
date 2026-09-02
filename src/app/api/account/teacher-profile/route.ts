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

  // One value, not two independently-mutable locals: `accountId` and `email`
  // used to be set separately, which let nothing stop a future branch from
  // setting one without the other. The discriminant is what every later
  // decision (which `teacher.create` shape, whether to mint a session,
  // whether SLUG_TAKEN re-mints a ticket) actually switches on.
  type Authorization = { source: 'ticket'; email: string } | { source: 'session'; accountId: string; email: string };
  let auth: Authorization;

  if (ticketEmail) {
    auth = { source: 'ticket', email: ticketEmail };
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
    auth = { source: 'session', accountId: session.accountId, email: account.email };
  }

  try {
    const teacher = await prisma.teacher.create({
      data: {
        firstName, lastName, bio, pageSlug,
        email: auth.email,
        defaultCurrency: 'EUR',
        // Falls back to Amsterdam only when the browser couldn't report one
        // (#258) — never an unconditional overwrite of what Task 1's schema
        // carries through from detection.
        defaultTimezone: defaultTimezone ?? 'Europe/Amsterdam',
        // A ticket has no account yet; a session has one already.
        ...(auth.source === 'session' ? { accountId: auth.accountId } : { account: { create: { email: auth.email } } }),
      },
    });

    const response = respondOk({ teacherId: teacher.id }, 201);
    if (auth.source === 'ticket') {
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
      // `requireSession` and 401s. Safe to re-mint: `auth.source === 'ticket'`
      // only holds because THIS request already consumed a ticket proving
      // ownership of it, so minting another proves nothing new. Session-authed
      // callers have no ticket to replace, so this is skipped for them.
      if (auth.source === 'ticket') {
        const freshTicket = await mintSignupTicket(prisma, auth.email);
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
