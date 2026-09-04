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
  signupTicketCrossFamilyPurpose,
  type SignupFamily,
} from './signup-ticket';

/**
 * The minimal read surface this module needs from a cookie jar — satisfied
 * structurally by both `NextRequest.cookies` (a route handler) and
 * `next/headers`'s `cookies()` (a server component), so `ticketTokenFrom`
 * applies the same rule from either.
 */
interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * The precedence rule, and the only place it is spelled: a signup ticket is
 * readable only when the request carries no session cookie at all.
 *
 * PRESENCE, not validity. An unparseable or expired session cookie still
 * routes to the session path, so the caller meets `requireSession`'s own 401
 * rather than silently spending a ticket that is not theirs.
 */
export function ticketTokenFrom(cookies: CookieReader): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME) !== undefined
    ? undefined
    : cookies.get(SIGNUP_TICKET_COOKIE)?.value;
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
 * Two failure shapes stay distinguishable here — `invalid_body` (the
 * caller's request was malformed) and `no_session` (no credential at all) —
 * because a caller that only ever forwards `response` verbatim still needs a
 * way to tell them apart in tests, and a future caller that wants to react
 * differently to each has somewhere to branch.
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
  if (!peeked) {
    // `peekSignupTicket` itself stays silent (see its own docblock for why).
    // A ticket cookie reaching an actual profile submission is a more
    // consequential moment than a mere peek, so this is where cross-family
    // presentation gets a trail instead — the row itself is left untouched:
    // this branch returns below without ever reaching the `consumeSignupTicket`
    // call further down.
    const crossFamilyPurpose = await signupTicketCrossFamilyPurpose(db, token, family);
    if (crossFamilyPurpose) {
      log.warn(
        { purpose: crossFamilyPurpose, family },
        'signup ticket cookie carried a token from a different family; left untouched, not honoured',
      );
    }
    return { kind: 'fall_through' };
  }

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

/**
 * Applies a `TicketOutcome` to the shape both resolvers return, or signals
 * that there was nothing terminal to return — an exhaustive `switch` so a
 * fourth `TicketOutcome` kind fails to compile here instead of silently
 * falling through to the session path the way an `if`-chain would.
 */
function dispatchTicketOutcome<TBody>(
  ticket: TicketOutcome<TBody>,
): ProfileAuthorizationOutcome<{ source: 'ticket'; email: string; body: TBody }> | undefined {
  switch (ticket.kind) {
    case 'invalid_body':
      return { ok: false, reason: 'invalid_body', response: ticket.response };
    case 'authorized':
      return { ok: true, auth: { source: 'ticket', email: ticket.email, body: ticket.body } };
    case 'fall_through':
      return undefined;
    default: {
      const unreachable: never = ticket;
      throw new Error(`dispatchTicketOutcome: unhandled TicketOutcome kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

type SessionOutcome =
  | { ok: true; email: string; session: SessionUser }
  | { ok: false; reason: 'no_session'; response: NextResponse };

/** `db` is for the account lookup; `requireSession` takes no client parameter. */
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
  const token = ticketTokenFrom(request.cookies);
  if (token) {
    const ticket = await ticketAuthorization(db, request, family, schema, token);
    const dispatched = dispatchTicketOutcome(ticket);
    if (dispatched) return dispatched;
  }

  const session = await sessionAuthorization(db, request);
  if (!session.ok) return session;

  // A second call to parseBody, but never a second read of the same stream:
  // reaching here with the body already parsed takes a peek-then-lost-consume
  // race, and such a request carries no session cookie at all — `ticketTokenFrom`
  // hands back a token only when there is none — so `sessionAuthorization`
  // has already answered 401 and returned above.
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
  const token = ticketTokenFrom(request.cookies);
  if (token) {
    const ticket = await ticketAuthorization(db, request, family, schema, token);
    const dispatched = dispatchTicketOutcome(ticket);
    if (dispatched) return dispatched;
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
