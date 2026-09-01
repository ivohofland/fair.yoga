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
  clearSignupTicketCookie,
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

  const parsed = await parseBody(request, teacherProfileSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, bio, pageSlug } = parsed.data;

  try {
    const teacher = await prisma.teacher.create({
      data: {
        firstName, lastName, email, bio, pageSlug,
        defaultCurrency: 'EUR',
        defaultTimezone: 'Europe/Amsterdam',
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
      return respondError('Page address already in use', 409, 'SLUG_TAKEN');
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
