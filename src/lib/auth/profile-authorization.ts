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
  clearSignupTicketCookie,
  foreignTicketCookiePurpose,
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
 * The precedence rule: a signup ticket is readable only when the request
 * carries no session cookie at all.
 *
 * PRESENCE, not validity. An unparseable or expired session cookie still
 * routes to the session path, so the caller meets `requireSession`'s own 401
 * rather than silently spending a ticket that is not theirs.
 *
 * Which callers apply it is a census, and it has a home: see
 * `docs/technical-architecture.md`, "The signup-ticket precedence rule".
 */
export function ticketTokenFrom(cookies: CookieReader): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME) !== undefined
    ? undefined
    : cookies.get(SIGNUP_TICKET_COOKIE)?.value;
}

/** `email` is the AUTHORIZED address, from the consumed ticket. Never a body. */
type TicketAuthorization<TBody> = { source: 'ticket'; email: string; body: TBody };

/**
 * `email` is the authorized address again, this time the session account's.
 *
 * `ticketCookiePresent` says only that: present. This arm is reached because
 * a session cookie outranked the ticket, so the ticket was never examined and
 * may be perfectly live — "stale" would be a claim nothing here checks.
 */
type SessionAuthorization = {
  source: 'session';
  email: string;
  session: SessionUser;
  ticketCookiePresent: boolean;
};

/** Only the ticket path submits a form; the session path posts nothing (student). */
export type TicketOnlyProfileAuthorization<TBody> =
  | TicketAuthorization<TBody>
  | SessionAuthorization;

/** Both paths submit the same form (teacher) — the one difference, in full. */
export type ProfileAuthorization<TBody> =
  | TicketAuthorization<TBody>
  | (SessionAuthorization & { body: TBody });

/**
 * `reason` drives no control flow: every failure arrives with a `response`
 * already built, so `return outcome.response` is total over the union. It is
 * named because the tests read it, and asserting `invalid_body` says more
 * than asserting `400` — one is the domain fact, the other `respondError`'s.
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
 * value, never the peek: only the consume proves the ticket was still live,
 * and still ours, at the moment it was spent.
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
    // A ticket cookie reaching an actual profile submission is a more
    // consequential moment than a page render's peek, so a token this door
    // will not honour gets its trail here. The row is left untouched: this
    // branch returns below without reaching the `consumeSignupTicket` call.
    const foreignPurpose = await foreignTicketCookiePurpose(db, token, family);
    if (foreignPurpose) {
      log.warn(
        { module: 'profile-authorization', purpose: foreignPurpose, family },
        'signup ticket cookie carried a live token this door does not honour; left untouched',
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
    log.warn(
      { module: 'profile-authorization', family },
      'ticket peeked live but did not consume',
    );
    return { kind: 'fall_through' };
  }
  return { kind: 'authorized', email, body: parsed.data };
}

/**
 * Applies a `TicketOutcome` to the shape both resolvers return, or signals
 * that there was nothing terminal to return — an exhaustive `switch` so a
 * NEW `TicketOutcome` kind fails to compile here instead of silently falling
 * through to the session path the way an `if`-chain would.
 */
function dispatchTicketOutcome<TBody>(
  ticket: TicketOutcome<TBody>,
): ProfileAuthorizationOutcome<TicketAuthorization<TBody>> | undefined {
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

/**
 * Clears the ticket cookie the precedence rule declined, on whichever exit
 * the caller is taking. A no-op on the ticket arm, which spent its ticket and
 * settles its own cookie — and that is the point: a route can send every
 * refusal through one call instead of remembering the flag at each `return`,
 * which is how the two 409s that forgot came to differ from the rest.
 */
export function clearDeclinedTicketCookie(
  response: NextResponse,
  auth: { source: 'ticket' } | { source: 'session'; ticketCookiePresent: boolean },
): NextResponse {
  if (auth.source === 'session' && auth.ticketCookiePresent) {
    clearSignupTicketCookie(response.headers);
  }
  return response;
}

/** For a family whose session path submits no body at all. */
export async function resolveTicketOnlyProfileAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
): Promise<ProfileAuthorizationOutcome<TicketOnlyProfileAuthorization<TBody>>> {
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
      ticketCookiePresent: request.cookies.get(SIGNUP_TICKET_COOKIE) !== undefined,
    },
  };
}

/**
 * For a family whose session path submits the same form as its ticket path —
 * which is the whole difference, so this adds a body to the session arm of
 * the resolver above rather than repeating it.
 */
export async function resolveProfileAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
): Promise<ProfileAuthorizationOutcome<ProfileAuthorization<TBody>>> {
  const base = await resolveTicketOnlyProfileAuthorization(db, request, family, schema);
  if (!base.ok) return base;
  // The ticket arm already carries its body: `ticketAuthorization` parsed it
  // before spending the ticket, which is the ordering that keeps a typo from
  // burning one.
  if (base.auth.source === 'ticket') return { ok: true, auth: base.auth };

  // A second call to parseBody, but never a second read of the same stream:
  // reaching here at all means the session arm was taken, and the ticket arm
  // — the only one that parses — is unreachable once a session cookie is
  // present, which is exactly the condition the session arm was taken under.
  const parsed = await parseBody(request, schema);
  if ('error' in parsed) return { ok: false, reason: 'invalid_body', response: parsed.error };

  return { ok: true, auth: { ...base.auth, body: parsed.data } };
}
