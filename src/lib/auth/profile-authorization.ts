import type { NextRequest, NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { requireSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import type { SessionUser } from '@/lib/types';
import { log } from '@/lib/log';
import { SESSION_COOKIE_NAME } from './session';
import {
  SIGNUP_TICKET_COOKIE,
  peekSignupTicket,
  consumeSignupTicket,
  type SignupFamily,
} from './signup-ticket';

/**
 * The precedence rule, and the only place it is spelled: a signup ticket is
 * readable only when the request carries no session cookie at all.
 *
 * PRESENCE, not validity. An unparseable or expired session cookie still
 * routes to the session path, so the caller meets `requireSession`'s own 401
 * rather than silently spending a ticket that is not theirs.
 */
export function ticketTokenFrom(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME) !== undefined
    ? undefined
    : request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
}

/** Both paths submit the same form (teacher). */
export type FormProfileAuthorization<TBody> =
  | { source: 'ticket'; email: string; body: TBody }
  | {
      source: 'session';
      email: string;
      session: SessionUser;
      staleTicketCookie: boolean;
      body: TBody;
    };

/** Only the ticket path submits a form; the session path posts nothing (student). */
export type TicketFormProfileAuthorization<TBody> =
  | { source: 'ticket'; email: string; body: TBody }
  | {
      source: 'session';
      email: string;
      session: SessionUser;
      staleTicketCookie: boolean;
    };

/**
 * `reason` is redundant to today's callers, which return `response` verbatim.
 * It is here so the two failures stay distinguishable to tests and to the
 * next refactor — a helper with more than one failure mode that reports only
 * a response has already collapsed them.
 */
export type ProfileAuthorizationOutcome<TAuth> =
  | { ok: true; auth: TAuth }
  | { ok: false; reason: 'invalid_body' | 'no_session'; response: NextResponse };

type TicketOutcome<TBody> =
  | { kind: 'authorized'; email: string; body: TBody }
  | { kind: 'invalid_body'; response: NextResponse }
  | { kind: 'fall_through' };

/**
 * Peek, then parse, then consume — the order is the whole point.
 *
 * Peek first so a stale cookie falls through to the session path instead of
 * failing a body parse the caller never needed. Parse before consuming so a
 * typo does not burn a single-use ticket. Take the address from the CONSUMED
 * value, never the peek — see `consumeSignupTicket`'s docblock for why.
 */
async function ticketAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
  token: string,
): Promise<TicketOutcome<TBody>> {
  const peeked = await peekSignupTicket(db, token, family);
  if (!peeked) return { kind: 'fall_through' };

  const parsed = await parseBody(request, schema);
  if ('error' in parsed) return { kind: 'invalid_body', response: parsed.error };

  const email = await consumeSignupTicket(db, token, family);
  if (!email) {
    // The peek found a live, correct-family ticket moments ago and the
    // consume then lost it — a TTL boundary crossed, or a concurrent
    // double-submit spent it first. Benign, but otherwise indistinguishable
    // from a request that never carried a ticket.
    log.warn({ family }, 'profile authorization: ticket peeked live but did not consume');
    return { kind: 'fall_through' };
  }
  return { kind: 'authorized', email, body: parsed.data };
}

type SessionOutcome =
  | { ok: true; email: string; session: SessionUser }
  | { ok: false; reason: 'no_session'; response: NextResponse };

/**
 * `db` covers the account lookup only. `requireSession` reaches into the
 * shared `prisma` singleton directly and takes no client argument — that's
 * its existing shape, not something to route through here. Do not "fix" it
 * by threading `db` through `requireSession`; that widens this change into
 * every route that calls it.
 */
async function sessionAuthorization(
  db: PrismaClient,
  request: NextRequest,
): Promise<SessionOutcome> {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return { ok: false, reason: 'no_session', response: session };
  const account = await db.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });
  return { ok: true, email: account.email, session };
}

/** For a family whose session path submits the same form as its ticket path. */
export async function resolveProfileAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
): Promise<ProfileAuthorizationOutcome<FormProfileAuthorization<TBody>>> {
  const token = ticketTokenFrom(request);
  if (token) {
    const ticket = await ticketAuthorization(db, request, family, schema, token);
    if (ticket.kind === 'invalid_body') {
      return { ok: false, reason: 'invalid_body', response: ticket.response };
    }
    if (ticket.kind === 'authorized') {
      return { ok: true, auth: { source: 'ticket', email: ticket.email, body: ticket.body } };
    }
  }

  const session = await sessionAuthorization(db, request);
  if (!session.ok) return session;

  // A second call to parseBody, but never a second read of the same stream:
  // reaching here after the ticket branch already parsed the body can only
  // happen via a peek-then-lost-consume race, and that race always dead-ends
  // at sessionAuthorization's 401 above, because ticketTokenFrom gates on
  // cookie presence rather than validity. If that gate ever changes, re-check
  // this ordering.
  const parsed = await parseBody(request, schema);
  if ('error' in parsed) return { ok: false, reason: 'invalid_body', response: parsed.error };

  return {
    ok: true,
    auth: {
      source: 'session',
      email: session.email,
      session: session.session,
      staleTicketCookie: request.cookies.get(SIGNUP_TICKET_COOKIE) !== undefined,
      body: parsed.data,
    },
  };
}

/** For a family whose session path submits no body at all. */
export async function resolveTicketOnlyProfileAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
): Promise<ProfileAuthorizationOutcome<TicketFormProfileAuthorization<TBody>>> {
  const token = ticketTokenFrom(request);
  if (token) {
    const ticket = await ticketAuthorization(db, request, family, schema, token);
    if (ticket.kind === 'invalid_body') {
      return { ok: false, reason: 'invalid_body', response: ticket.response };
    }
    if (ticket.kind === 'authorized') {
      return { ok: true, auth: { source: 'ticket', email: ticket.email, body: ticket.body } };
    }
  }

  const session = await sessionAuthorization(db, request);
  if (!session.ok) return session;

  return {
    ok: true,
    auth: {
      source: 'session',
      email: session.email,
      session: session.session,
      staleTicketCookie: request.cookies.get(SIGNUP_TICKET_COOKIE) !== undefined,
    },
  };
}
