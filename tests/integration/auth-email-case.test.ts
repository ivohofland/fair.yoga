import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * #170. The stored address is lowercase; the caller types whatever they type.
 * Every fixture below is created lowercase and then addressed in mixed case —
 * an all-lowercase probe would pass against the unfixed code and prove nothing.
 */
describe('sign-in and signup are case-insensitive on email', () => {
  const studentEmail = `case-student-${suffix}@test.local`;
  const teacherEmail = `case-teacher-${suffix}@test.local`;
  let studentAccountId = '';
  let teacherAccountId = '';

  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Case', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { accountId: true },
    });
    studentAccountId = student.accountId ?? '';

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Case', lastName: 'Teacher', email: teacherEmail,
        bio: 'Fixture for #170', pageSlug: `case-teacher-${suffix}`,
        account: { create: { email: teacherEmail } },
      },
      select: { accountId: true },
    });
    teacherAccountId = teacher.accountId;
  });

  afterAll(async () => {
    await prisma.magicLinkToken.deleteMany({
      where: { email: { in: [studentEmail, teacherEmail] } },
    });
    await prisma.student.deleteMany({ where: { email: studentEmail } });
    await prisma.teacher.deleteMany({ where: { email: teacherEmail } });
    await prisma.account.deleteMany({
      where: { id: { in: [studentAccountId, teacherAccountId].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it('issues a magic-link token when the address is typed in mixed case', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: studentEmail.toUpperCase() }),
    });
    expect(res.status).toBe(200);

    // The route answers 200 either way to prevent enumeration, so the response
    // body cannot distinguish success from silent failure. The token row is the
    // only observable difference — assert on it, not on the message.
    const tokens = await prisma.magicLinkToken.findMany({
      where: { email: studentEmail },
    });
    expect(tokens).toHaveLength(1);
  });

  it('does not create a second Account for a mixed-case signup', async () => {
    const before = await prisma.account.count({ where: { email: { contains: suffix } } });

    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'Dup', lastName: 'Attempt',
        email: studentEmail.toUpperCase(),
      }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.account.count({ where: { email: { contains: suffix } } })).toBe(before);
    expect(await prisma.account.count({ where: { email: studentEmail } })).toBe(1);
  });

  it('finds a passkey account when the address is typed in mixed case', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: teacherEmail.toUpperCase() }),
    });
    expect(res.status).toBe(200);

    // No credential is registered for this fixture, so the assertion is that
    // the route resolved the account at all rather than that ids came back.
    // A 200 with the account unresolved is indistinguishable here, so this
    // test is the weakest of the three — it is the mutation check in Step 7
    // that gives it teeth.
    const body = await res.json();
    expect(body).toHaveProperty('data.options');
  });
});

/**
 * #168: Short-circuiting IP rate limit before email rate limit.
 *
 * An IP-blocked caller hammering `/api/auth/magic-link/send` must be stopped
 * at the IP check and never insert or increment a per-email rate limit bucket
 * for the target address.
 */
describe('POST /api/auth/magic-link/send — IP rate limit short-circuit', () => {
  it('does not consume a victim address email budget when request is rejected by IP limit', async () => {
    const throttledIp = freshIp();
    const victimEmail = `victim-${uniqueSuffix()}@test.local`;

    // 1. Spend the 10/15min IP budget from throttledIp using distinct throwaway emails
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...throttledIp },
        body: JSON.stringify({ email: `dummy-${i}-${suffix}@test.local` }),
      });
      expect(res.status).toBe(200);
    }

    // 2. The 11th request from throttledIp targeting victimEmail is 429'd by the IP check
    const blockedRes = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...throttledIp },
      body: JSON.stringify({ email: victimEmail }),
    });
    expect(blockedRes.status).toBe(429);
    const blockedBody = await blockedRes.json();
    expect(blockedBody.error.message).toMatch(/^Too many sign-in requests\. Try again in \d{1,2} minutes?\.$/);

    // 3. From a fresh IP, victimEmail must still have its full 3/15min email budget untouched.
    // In pre-fix code (without short-circuiting), request #2 consumed 1 hit, leaving only 2 allowed hits.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...freshIp() },
        body: JSON.stringify({ email: victimEmail }),
      });
      expect(res.status).toBe(200);
    }

    // 4. The 4th request from a fresh IP for victimEmail is now blocked by the per-email limit
    const emailBlockedRes = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: victimEmail }),
    });
    expect(emailBlockedRes.status).toBe(429);
    const emailBlockedBody = await emailBlockedRes.json();
    expect(emailBlockedBody.error.message).toMatch(
      /^Too many sign-in requests\. Try again in \d{1,2} minutes?\.$/,
    );
  });
});
