import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from './signup-ticket';
import * as signupTicket from './signup-ticket';
import {
  ticketTokenFrom,
  resolveProfileAuthorization,
  resolveTicketOnlyProfileAuthorization,
} from './profile-authorization';
import { teacherProfileSchema, studentProfileSchema } from '@/lib/schemas';
import { log } from '@/lib/log';

// Real by default (importOriginal) — `ticketAuthorization`'s call to
// `consumeSignupTicket` only goes through this mock at all when a specific
// test overrides it with `vi.spyOn`, which the peeked-but-lost-consume test
// below needs: that race can't be reproduced with real timing, only by
// making a genuinely live ticket's consume call return null anyway.
vi.mock('./signup-ticket', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./signup-ticket')>();
  return { ...actual };
});

const prisma = new PrismaClient();
const suffix = `pa-${Date.now()}`;

beforeAll(async () => { await prisma.$connect(); });

afterEach(() => { vi.restoreAllMocks(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

function req(cookies: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/account/teacher-profile', {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('ticketTokenFrom — the precedence rule', () => {
  it('returns the ticket token when no session cookie is present', () => {
    expect(ticketTokenFrom(req('fair_yoga_signup=abc').cookies)).toBe('abc');
  });

  it('returns undefined when a session cookie is present, however invalid', () => {
    // Presence, not validity: an unparseable session cookie must surface
    // `requireSession`'s own 401, never fall through to someone else's ticket.
    expect(ticketTokenFrom(req('fair_yoga_session=not-a-real-token; fair_yoga_signup=abc').cookies))
      .toBeUndefined();
  });

  it('returns undefined when a session cookie is present with an empty value', () => {
    // Empty value is still presence; the rule blocks the ticket path entirely.
    expect(ticketTokenFrom(req('fair_yoga_session=; fair_yoga_signup=abc').cookies))
      .toBeUndefined();
  });

  it('returns undefined when neither cookie is present', () => {
    expect(ticketTokenFrom(req('').cookies)).toBeUndefined();
  });

  it('works from a plain cookie store too, not only NextRequest.cookies', () => {
    // A server component reads cookies via next/headers, not a NextRequest
    // — this is the structural-typing guarantee that lets any caller with a
    // compatible `.get()` reuse this function instead of re-implementing
    // the rule.
    const store = { get: (name: string) => (name === 'fair_yoga_signup' ? { value: 'abc' } : undefined) };
    expect(ticketTokenFrom(store)).toBe('abc');
  });
});

const VALID_TEACHER_BODY = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  bio: '',
  pageSlug: 'ada-lovelace-plan-fixture',
};

describe('resolveProfileAuthorization — ticket path', () => {
  it('authorizes with the address from the ticket and returns the parsed body', async () => {
    const email = `resolver-ok-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.auth.source).toBe('ticket');
    expect(outcome.auth.email).toBe(email);
    if (outcome.auth.source !== 'ticket') return;
    expect(outcome.auth.body.firstName).toBe('Ada');
  });

  it('takes the authorized address from consumeSignupTicket, never from the earlier peek', async () => {
    // The two calls resolve DIFFERENT emails here — a shape that could only
    // happen for real via a same-token race, but it isolates which value the
    // resolver actually reads. If it read the peek, this would authorize the
    // wrong address.
    const peekedEmail = `resolver-peek-addr-${suffix}@test.local`;
    const consumedEmail = `resolver-consume-addr-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, peekedEmail, 'teacher');
    vi.spyOn(signupTicket, 'consumeSignupTicket').mockResolvedValueOnce(consumedEmail);

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.auth.source).toBe('ticket');
    expect(outcome.auth.email).toBe(consumedEmail);
  });

  it('falls through to the session path (and logs) when a live ticket is lost between peek and consume', async () => {
    // Not reproducible with real timing — this is the TTL-boundary or
    // concurrent-double-submit race `ticketAuthorization`'s own comment
    // names, forced deterministically by making a genuinely live ticket's
    // consume call return null anyway.
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const email = `resolver-lostconsume-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');
    vi.spyOn(signupTicket, 'consumeSignupTicket').mockResolvedValueOnce(null);

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    // No session cookie either, so the fall-through dead-ends at the 401
    // `ticketAuthorization`'s own comment says it must — not a coincidence,
    // the precedence rule (session cookie presence) guarantees it.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'teacher' }),
      expect.stringContaining('peeked live but did not consume'),
    );
  });

  it('reports invalid_body and does NOT consume the ticket', async () => {
    const email = `resolver-badbody-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: '' }),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid_body');

    // The whole reason parse precedes consume: a typo must not cost the ticket.
    const still = await prisma.magicLinkToken.findFirst({ where: { email } });
    expect(still).not.toBeNull();
  });

  it('reports no_session when the ticket is absent and nothing else authorizes', async () => {
    const outcome = await resolveProfileAuthorization(
      prisma,
      req('', VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');
    expect(outcome.response.status).toBe(401);
  });

  it('ignores a live ticket entirely when a session cookie is present', async () => {
    const email = `resolver-precedence-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_session=bogus; fair_yoga_signup=${token}`, VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    // Falls to the session path, which 401s on the bogus session cookie.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');

    // And the ticket is untouched — it was never anyone's to spend here.
    const still = await prisma.magicLinkToken.findFirst({ where: { email } });
    expect(still).not.toBeNull();
  });
});

describe('resolveTicketOnlyProfileAuthorization', () => {
  it('authorizes a ticket without requiring a session-path body', async () => {
    const email = `resolver-student-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'student');

    const outcome = await resolveTicketOnlyProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: 'Bo', lastName: 'Peep' }),
      'student',
      studentProfileSchema,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.auth.source !== 'ticket') return;
    expect(outcome.auth.email).toBe(email);
  });

  it('shields, rather than consumes, a cross-family ticket', async () => {
    const email = `resolver-crossfam-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveTicketOnlyProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: 'Bo', lastName: 'Peep' }),
      'student',
      studentProfileSchema,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');

    // The peek that filters this out is read-only — unlike presenting a
    // cross-family token directly to `consumeSignupTicket`, this path never
    // reaches (and never deletes) the row.
    const still = await prisma.magicLinkToken.findFirst({ where: { email } });
    expect(still).not.toBeNull();
  });

  it('logs a cross-family ticket presentation, unlike an ordinary missing/expired one', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const email = `resolver-crossfam-logged-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    await resolveTicketOnlyProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: 'Bo', lastName: 'Peep' }),
      'student',
      studentProfileSchema,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'teacher_profile_pending', family: 'student' }),
      expect.stringContaining('carried a token from a different family'),
    );
  });

  it('does not log when there is no ticket cookie to begin with', async () => {
    // A weaker check than the one below: `ticketAuthorization` (and its
    // cross-family guard) never runs at all here, so this only proves the
    // resolver stays quiet with nothing to report — not that the guard
    // itself discriminates correctly.
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);

    await resolveTicketOnlyProfileAuthorization(prisma, req(''), 'student', studentProfileSchema);

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not log for a same-family cookie naming a dead ticket, the actual foil for the guard above', async () => {
    // Unlike the "no cookie" case above, this reaches `ticketAuthorization`'s
    // `if (!peeked)` branch — the same branch the cross-family log fires
    // from — so this is what actually proves the guard discriminates
    // "expired" from "cross-family" rather than logging on every fall-through.
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const email = `resolver-deadticket-nolog-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'student');
    await prisma.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await resolveTicketOnlyProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`),
      'student',
      studentProfileSchema,
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
