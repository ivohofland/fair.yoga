import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  // `Session` carries a bare `accountId`, no `@relation` back to `Account`
  // (schema.prisma:1014-1021) — a nested `{ account: { email: ... } }` filter
  // isn't a valid Prisma query on this schema, so the matching accounts are
  // looked up first, the same shape `student-signup-verify.test.ts` uses.
  const accountIds = (
    await prisma.account.findMany({ where: { email: { contains: suffix } }, select: { id: true } })
  ).map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

function post(ticket: string | null, body: unknown) {
  return fetch(`${BASE_URL}/api/account/student-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ticket ? { Cookie: `fair_yoga_signup=${ticket}` } : {}),
      ...freshIp(),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/student-profile — ticket authorization', () => {
  it('creates the student and account, claimed and with no tier chosen yet', async () => {
    const email = `profile-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    const res = await post(ticket, { firstName: 'Anna', lastName: 'Smith' });
    expect(res.status).toBe(201);
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('fair_yoga_session=');
    // The spent ticket is cleared, not left naming a dead token.
    expect(cookies).toContain('fair_yoga_signup=;');

    const student = await prisma.student.findUniqueOrThrow({ where: { email } });
    expect(student.firstName).toBe('Anna');
    expect(student.lastName).toBe('Smith');
    expect(student.accountId).not.toBeNull();

    // The two census columns. `claimedAt` null would drop this student into
    // `bypassesPrivacy`, handing their teacher every field they never shared.
    expect(student.claimedAt).not.toBeNull();
    // A stamped `tierSelectedAt` would suppress the tier picker forever, so
    // they would be billed at the default without ever having chosen.
    expect(student.tierSelectedAt).toBeNull();
    expect(student.incomeTier).toBe(3);
  });

  it('takes the address from the ticket, never from the body', async () => {
    const email = `profile-ticket-addr-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    // A body key the strict schema does not know is refused outright.
    const res = await post(ticket, {
      firstName: 'Mallory',
      lastName: 'Body',
      email: `profile-ticket-evil-${suffix}@test.local`,
    });
    expect(res.status).toBe(400);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });

  it('rejects a malformed body without spending the ticket', async () => {
    const email = `profile-ticket-retry-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    expect((await post(ticket, { firstName: '', lastName: '' })).status).toBe(400);

    // The same ticket still works: a typo must not cost a single-use ticket.
    const ok = await post(ticket, { firstName: 'Second', lastName: 'Try' });
    expect(ok.status).toBe(201);
    await prisma.student.findUniqueOrThrow({ where: { email } });
  });

  it('refuses a teacher-family ticket', async () => {
    const email = `profile-ticket-wrongfam-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'teacher');

    // No ticket the student route accepts, and no session either.
    const res = await post(ticket, { firstName: 'Wrong', lastName: 'Family' });
    expect(res.status).toBe(401);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses an expired ticket', async () => {
    const email = `profile-ticket-expired-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');
    await prisma.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await post(ticket, { firstName: 'Too', lastName: 'Late' });
    expect(res.status).toBe(401);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });
});
