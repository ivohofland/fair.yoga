import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession } from '../helpers';
import { mintSignupTicket } from '@/lib/auth';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const freshEmail = `teacher-signup-${suffix}@test.local`;
const ticketEmail = `teacher-signup-ticket-${suffix}@test.local`;
const ticketSlug = `ticket-teacher-${suffix}`;
const spentEmail = `teacher-signup-spent-${suffix}@test.local`;
const clashEmail = `teacher-signup-clash-${suffix}@test.local`;
const onboardingEmail = `teacher-signup-onboarding-${suffix}@test.local`;
const onboardingSlug = `onboarding-teacher-${suffix}`;

// A live teacher+session fixture, needed by the slug-available "already
// taken" test and by every POST /api/account/onboarding test.
let onboardingTeacherId: string;
let onboardingAccountId: string;
let onboardingToken: string;

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Onboarding',
      lastName: 'Teacher',
      email: onboardingEmail,
      bio: '',
      pageSlug: onboardingSlug,
      account: { create: { email: onboardingEmail } },
    },
  });
  onboardingTeacherId = teacher.id;
  onboardingAccountId = teacher.accountId;
  onboardingToken = await seedSession(prisma, onboardingAccountId);
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({
    where: { email: { in: [freshEmail, ticketEmail, spentEmail, clashEmail] } },
  });

  const accounts = await prisma.account.findMany({
    where: { email: { in: [ticketEmail, spentEmail, clashEmail] } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({
    where: { email: { in: [ticketEmail, spentEmail, clashEmail] } },
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });

  await prisma.session.deleteMany({ where: { accountId: onboardingAccountId } });
  await prisma.teacher.deleteMany({ where: { id: onboardingTeacherId } });
  await prisma.account.deleteMany({ where: { id: onboardingAccountId } });

  await prisma.$disconnect();
});

describe('POST /api/auth/teacher-signup', () => {
  it('creates no rows and mints a marked token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.account.findUnique({ where: { email: freshEmail } })).toBeNull();
    expect(await prisma.teacher.findUnique({ where: { email: freshEmail } })).toBeNull();

    const token = await prisma.magicLinkToken.findFirst({ where: { email: freshEmail } });
    expect(token?.purpose).toBe('teacher_signup');
  });

  // Losing the email is the only failure mode with no other recovery:
  // magic-link/send looks up Teacher-then-Student and an unfinished signup
  // has neither, so re-running /signup IS the recovery path.
  it('is re-runnable for an address it has already seen', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a body carrying anything but an email', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail, pageSlug: 'sneaky' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/account/teacher-profile', () => {
  it('rejects a caller with neither ticket nor session', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'No', lastName: 'Auth', bio: '', pageSlug: `no-auth-${suffix}`,
      }),
    });
    expect(res.status).toBe(401);
    expect(await prisma.teacher.findUnique({ where: { pageSlug: `no-auth-${suffix}` } })).toBeNull();
  });

  it('creates account, teacher and session from a ticket', async () => {
    const ticket = await mintSignupTicket(prisma, ticketEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'Anna', lastName: 'de Vries', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_session=');

    const teacher = await prisma.teacher.findUnique({ where: { pageSlug: ticketSlug } });
    expect(teacher?.email).toBe(ticketEmail);
    // The address comes from the ticket, never the body.
    expect(teacher?.bio).toBe('');
  });

  it('refuses a spent ticket', async () => {
    const ticket = await mintSignupTicket(prisma, spentEmail);
    const body = JSON.stringify({
      firstName: 'A', lastName: 'B', bio: '', pageSlug: `spent-${suffix}`,
    });
    const headers = {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_signup=${ticket}`,
      ...freshIp(),
    };
    await fetch(`${BASE_URL}/api/account/teacher-profile`, { method: 'POST', headers, body });
    const second = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST', headers,
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: `spent2-${suffix}`,
      }),
    });
    expect(second.status).toBe(401);
  });

  it('answers SLUG_TAKEN for an address someone already holds', async () => {
    const ticket = await mintSignupTicket(prisma, clashEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SLUG_TAKEN');
  });
});

// #385 controller ruling: Steps 11-12 implement GET /api/teachers/slug-available
// and POST /api/account/onboarding with no preceding failing-test step. These
// two describe blocks close that gap, kept minimal and matched to what each
// route actually guards.
describe('GET /api/teachers/slug-available', () => {
  it('reports an available slug as available', async () => {
    const res = await fetch(
      `${BASE_URL}/api/teachers/slug-available?slug=slug-check-available-${suffix}`,
      { headers: { ...freshIp() } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: true });
  });

  it('reports a slug already held by an existing teacher as unavailable', async () => {
    const res = await fetch(
      `${BASE_URL}/api/teachers/slug-available?slug=${onboardingSlug}`,
      { headers: { ...freshIp() } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: false });
  });

  // Can't easily prove "no database read happened" from an HTTP test, so
  // this just asserts the response is correct — sufficient coverage here.
  it('reports a reserved slug as unavailable', async () => {
    const res = await fetch(
      `${BASE_URL}/api/teachers/slug-available?slug=signup`,
      { headers: { ...freshIp() } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: false });
  });
});

describe('POST /api/account/onboarding', () => {
  it('is idempotent: skipping a step twice only adds it once', async () => {
    const first = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'profile' }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(onboardingToken), ...freshIp() },
      body: JSON.stringify({ step: 'profile' }),
    });
    expect(second.status).toBe(200);

    const teacher = await prisma.teacher.findUnique({
      where: { id: onboardingTeacherId },
      select: { skippedOnboarding: true },
    });
    expect(teacher?.skippedOnboarding.filter((s) => s === 'profile')).toHaveLength(1);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await fetch(`${BASE_URL}/api/account/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ step: 'bank' }),
    });
    expect(res.status).toBe(401);
  });
});
