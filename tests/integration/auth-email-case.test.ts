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
    const before = await prisma.account.count();

    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'Dup', lastName: 'Attempt',
        email: studentEmail.toUpperCase(),
      }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.account.count()).toBe(before);
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
