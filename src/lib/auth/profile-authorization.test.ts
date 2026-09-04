import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from './signup-ticket';
import {
  ticketTokenFrom,
  resolveProfileAuthorization,
  resolveTicketOnlyProfileAuthorization,
} from './profile-authorization';
import { teacherProfileSchema, studentProfileSchema } from '@/lib/schemas';

const prisma = new PrismaClient();
const suffix = `pa-${Date.now()}`;

beforeAll(async () => { await prisma.$connect(); });

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
    expect(ticketTokenFrom(req('fair_yoga_signup=abc'))).toBe('abc');
  });

  it('returns undefined when a session cookie is present, however invalid', () => {
    // Presence, not validity: an unparseable session cookie must surface
    // `requireSession`'s own 401, never fall through to someone else's ticket.
    expect(ticketTokenFrom(req('fair_yoga_session=not-a-real-token; fair_yoga_signup=abc')))
      .toBeUndefined();
  });

  it('returns undefined when neither cookie is present', () => {
    expect(ticketTokenFrom(req(''))).toBeUndefined();
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

  it('discards a cross-family ticket rather than honouring it', async () => {
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
  });
});
