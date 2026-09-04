import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { respondOk, respondError, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { teacherProfileSchema } from '@/lib/schemas';
import {
  mintSignupTicket,
  clearSignupTicketCookie,
  setSignupTicketCookie,
  createSession,
  setSessionCookie,
  resolveProfileAuthorization,
  clearDeclinedTicketCookie,
} from '@/lib/auth';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';

/**
 * Creates the teacher profile (#385). Two authorizations, one route: the
 * signup ticket (new signup, no account yet) or a live session (an existing
 * account adding the teacher hat — the mirror of `student-profile`'s "join
 * as a student"). `resolveProfileAuthorization` applies the resolver's
 * shared ticket-vs-session precedence rule (#428) — see
 * `profile-authorization.ts`.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const outcome = await resolveProfileAuthorization(
    prisma,
    request,
    'teacher',
    teacherProfileSchema,
  );
  if (!outcome.ok) return outcome.response;
  const auth = outcome.auth;
  const { firstName, lastName, bio, pageSlug, defaultTimezone } = auth.body;

  if (auth.source === 'session' && auth.session.teacherId) {
    return clearDeclinedTicketCookie(
      respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER'),
      auth,
    );
  }

  // Only the `create` is inside: every branch of the catch below names a
  // unique constraint on the teacher row, so a failure from the session mint
  // that followed would be reported as a collision that never happened.
  let teacher;
  try {
    teacher = await prisma.teacher.create({
      data: {
        firstName, lastName, bio, pageSlug,
        email: auth.email,
        defaultCurrency: 'EUR',
        // Falls back to Amsterdam only when the browser couldn't report one
        // (#258) — never an unconditional overwrite of what Task 1's schema
        // carries through from detection.
        defaultTimezone: defaultTimezone ?? 'Europe/Amsterdam',
        // A ticket has no account yet; a session has one already.
        ...(auth.source === 'session'
          ? { accountId: auth.session.accountId }
          : { account: { create: { email: auth.email } } }),
      },
    });
  } catch (err) {
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      const conflict = respondError('Page address already in use', 409, 'SLUG_TAKEN');
      // The ticket that got us here is already spent (single-use, consumed
      // above) — without a fresh one the client's cookie now names a dead
      // token, and a retry (even with a different slug) falls through to
      // `requireSession` and 401s. Safe to re-mint: `auth.source === 'ticket'`
      // only holds because THIS request already consumed a ticket proving
      // ownership of it, so minting another proves nothing new. Session-authed
      // callers have no ticket to replace, so this is skipped for them; the
      // cookie the rule declined for them is cleared below instead.
      if (auth.source === 'ticket') {
        const freshTicket = await mintSignupTicket(prisma, auth.email, 'teacher');
        setSignupTicketCookie(conflict.headers, freshTicket);
      }
      return clearDeclinedTicketCookie(conflict, auth);
    }
    if (isUniqueConflictOn(err, ['email']) || isUniqueConflictOn(err, ['accountId'])) {
      return clearDeclinedTicketCookie(
        respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER'),
        auth,
      );
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

  const response = respondOk({ teacherId: teacher.id }, 201);
  if (auth.source === 'ticket') {
    const sessionToken = await createSession(prisma, teacher.accountId);
    setSessionCookie(response.headers, sessionToken);
    clearSignupTicketCookie(response.headers);
  }
  return clearDeclinedTicketCookie(response, auth);
});
