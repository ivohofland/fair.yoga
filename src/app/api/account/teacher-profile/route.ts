import { NextRequest, type NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { respondOk, respondError, respondUnchanged, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { teacherProfileSchema, PAGE_SLUG_TAKEN_MESSAGE } from '@/lib/schemas';
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
import { liveProfile } from '@/lib/live-profile';
import { log } from '@/lib/log';

/**
 * What a request asks the teacher row to hold: the parsed body with the
 * route's timezone default applied. The create writes exactly this, and the
 * unchanged check compares exactly this.
 */
type RequestedProfile = Omit<z.infer<typeof teacherProfileSchema>, 'defaultTimezone'> & {
  defaultTimezone: string;
};

/**
 * The columns a live teacher side must already hold for a request to be one
 * that already happened. Keyed by the request's own fields, so a field added
 * to `teacherProfileSchema` fails to compile here until it is compared too.
 */
const COMPARED_COLUMNS = {
  firstName: true,
  lastName: true,
  bio: true,
  pageSlug: true,
  defaultTimezone: true,
} as const satisfies Record<keyof RequestedProfile, true>;

const COMPARED_FIELDS = Object.keys(COMPARED_COLUMNS) as Array<keyof RequestedProfile>;

/**
 * The answer for an account that already holds a live teacher side:
 * `unchanged` when that side holds exactly what this request asks for,
 * `ALREADY_TEACHER` when it holds anything else, and null when the account
 * holds no live teacher side. `liveProfile` decides liveness; the `where`
 * only bounds the fetch.
 */
async function answerForLiveTeacher(
  accountId: string,
  requested: RequestedProfile,
): Promise<NextResponse | null> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      teachers: {
        where: { deletedAt: null },
        select: { id: true, deletedAt: true, ...COMPARED_COLUMNS },
      },
    },
  });
  const live = liveProfile(account.teachers);
  if (!live) return null;
  if (COMPARED_FIELDS.every((field) => live[field] === requested[field])) {
    return respondUnchanged<{ teacherId: string }>({ teacherId: live.id });
  }
  return respondError(
    'You already have a teacher page. Edit it in Settings.',
    409,
    'ALREADY_TEACHER',
  );
}

/** A unique key a session-path create can collide on. */
function isSessionCollision(err: unknown): boolean {
  return (
    isUniqueConflictOn(err, ['accountId']) ||
    isUniqueConflictOn(err, ['email']) ||
    isUniqueConflictOn(err, ['pageSlug'])
  );
}

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
  const requested: RequestedProfile = {
    ...auth.body,
    // Falls back to Amsterdam only when the browser couldn't report one
    // (#258) — never an unconditional overwrite of what the schema carries
    // through from detection. A resubmit from a browser that still reports
    // no zone therefore matches the row it created.
    defaultTimezone: auth.body.defaultTimezone ?? 'Europe/Amsterdam',
  };

  // After authorization, which is this route's ownership gate: the only
  // teacher side this can read is the caller's own.
  if (auth.source === 'session' && auth.session.teacherId) {
    const answer = await answerForLiveTeacher(auth.session.accountId, requested);
    if (answer) return clearDeclinedTicketCookie(answer, auth);
  }

  // Only the `create` is inside: every branch of the catch below names a
  // unique constraint or partial unique index on the teacher row, so a
  // failure from the session mint that followed would be reported as a
  // collision that never happened.
  let teacher;
  try {
    teacher = await prisma.teacher.create({
      data: {
        ...requested,
        email: auth.email,
        defaultCurrency: 'EUR',
        // A ticket has no account yet; a session has one already.
        ...(auth.source === 'session'
          ? { accountId: auth.session.accountId }
          : { account: { create: { email: auth.email } } }),
      },
    });
  } catch (err) {
    if (auth.source === 'session' && isSessionCollision(err)) {
      // A session-path twin writes this account's `accountId`, its address
      // and the same slug, and Postgres reports whichever index it reaches
      // first. So every one of these re-reads the account and answers as the
      // pre-check does. Only a slug collision can find no teacher side there,
      // and then the slug belongs to another teacher.
      const answer = await answerForLiveTeacher(auth.session.accountId, requested);
      if (answer) return clearDeclinedTicketCookie(answer, auth);
      if (isUniqueConflictOn(err, ['pageSlug'])) {
        return clearDeclinedTicketCookie(
          respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN'),
          auth,
        );
      }
      log.error(
        { err, route: 'teacher-profile' },
        'teacher profile create collided on its own account key, but the account holds no live teacher side',
      );
      throw new Error('teacher profile create: account key collision with no live teacher side');
    }
    if (auth.source === 'ticket' && isUniqueConflictOn(err, ['pageSlug'])) {
      const conflict = respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
      // The ticket that got us here is already spent (single-use, consumed
      // above) — without a fresh one the client's cookie now names a dead
      // token, and a retry (even with a different slug) falls through to
      // `requireSession` and 401s. Safe to re-mint: `auth.source === 'ticket'`
      // only holds because THIS request already consumed a ticket proving
      // ownership of it, so minting another proves nothing new.
      const freshTicket = await mintSignupTicket(prisma, auth.email, 'teacher');
      setSignupTicketCookie(conflict.headers, freshTicket);
      return clearDeclinedTicketCookie(conflict, auth);
    }
    if (auth.source === 'ticket' && isUniqueConflictOn(err, ['email'])) {
      // The ticket path creates the account in this same statement, so its
      // address colliding means another account appeared for it during the
      // ticket's window. That account may have no teacher side at all.
      log.warn(
        { route: 'teacher-profile' },
        'teacher profile ticket path lost to an email that gained an account during the ticket window',
      );
      return clearDeclinedTicketCookie(
        respondError(
          'This email now has an account. Please sign in and add a teacher profile.',
          409,
          'ACCOUNT_EXISTS',
        ),
        auth,
      );
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // generic conflict, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher profile create hit a unique constraint its authorization path cannot reach',
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
