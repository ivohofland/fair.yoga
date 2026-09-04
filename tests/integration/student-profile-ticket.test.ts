import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  // `Session` carries a bare `accountId`, no `@relation` back to `Account` —
  // a nested `{ account: { email: ... } }` filter isn't a valid Prisma
  // query on this schema, so the matching accounts are looked up first, the
  // same shape `student-signup-verify.test.ts` uses.
  const accountIds = (
    await prisma.account.findMany({ where: { email: { contains: suffix } }, select: { id: true } })
  ).map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  // Teacher rows before Account: Teacher.accountId has no cascade, so an
  // Account with a live Teacher still attached would fail the delete below.
  await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
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
    const evilEmail = `profile-ticket-evil-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    // A body key the strict schema does not know is refused outright.
    const res = await post(ticket, {
      firstName: 'Mallory',
      lastName: 'Body',
      email: evilEmail,
    });
    expect(res.status).toBe(400);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
    // The bug this test is named for would have created the row under the
    // body's address instead of the ticket's — check there too, not just
    // the ticket's own address.
    expect(await prisma.student.findUnique({ where: { email: evilEmail } })).toBeNull();
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

  // PR #427 review, I1: on the ticket path an `email` collision means a
  // DIFFERENT account appeared for this address during the ticket's window
  // — not the caller's own row, since there is no caller. Simulated
  // directly (a real timing race isn't reachable over HTTP): seed the
  // Account between minting the ticket and posting the request.
  it('answers ACCOUNT_EXISTS, not the generic ALREADY_STUDENT, when an account claims the address during the ticket window', async () => {
    const email = `profile-ticket-raced-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');
    await prisma.account.create({ data: { email } });

    const res = await post(ticket, { firstName: 'Raced', lastName: 'Out' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ACCOUNT_EXISTS');
    expect(body.error.code).not.toBe('ALREADY_STUDENT');
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });
});

describe('POST /api/account/student-profile — a stale ticket cookie must not block the session path', () => {
  it('succeeds via session with no body, even with an expired signup-ticket cookie also present', async () => {
    const email = `profile-session-stale-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Stale',
        lastName: 'Ticket',
        email,
        bio: 'Fixture for #399 finding 4',
        pageSlug: `profile-session-stale-${suffix}`,
        account: { create: { email } },
      },
    });
    const rawSession = await seedSession(prisma, teacher.accountId);

    // A ticket for an abandoned signup at a DIFFERENT address, expired.
    // `magic-link/verify` never clears the ticket cookie, so a browser that
    // starts a signup, abandons it, then signs into an existing account can
    // carry both a live session and a dead ticket at once.
    const abandonedEmail = `profile-session-stale-abandoned-${suffix}@test.local`;
    const staleTicket = await mintSignupTicket(prisma, abandonedEmail, 'student');
    await prisma.magicLinkToken.updateMany({
      where: { email: abandonedEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: {
        Cookie: `fair_yoga_session=${rawSession}; fair_yoga_signup=${staleTicket}`,
        ...freshIp(),
      },
    });

    expect(res.status).toBe(201);
    const student = await prisma.student.findUniqueOrThrow({ where: { email } });
    expect(student.accountId).toBe(teacher.accountId);
  });

  // PR #427 review, C1, Scenario A: unlike the stale-ticket case above, a
  // LIVE ticket for a different address used to win the race in
  // `student-profile/route.ts` — `parseBody` opened on `JoinAsStudent`'s
  // empty body and threw before `requireSession` ever ran, answering 400
  // instead of using the session already on the request.
  it('succeeds via session with no body, even with a LIVE, unexpired signup-ticket cookie for a different address', async () => {
    const email = `profile-session-livetkt-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Live',
        lastName: 'Ticket',
        email,
        bio: 'Fixture for PR #427 review finding C1',
        pageSlug: `profile-session-livetkt-${suffix}`,
        account: { create: { email } },
      },
    });
    const rawSession = await seedSession(prisma, teacher.accountId);

    const otherEmail = `profile-session-livetkt-other-${suffix}@test.local`;
    const liveTicket = await mintSignupTicket(prisma, otherEmail, 'student');

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: {
        Cookie: `fair_yoga_session=${rawSession}; fair_yoga_signup=${liveTicket}`,
        ...freshIp(),
      },
    });

    expect(res.status).toBe(201);
    const student = await prisma.student.findUniqueOrThrow({ where: { email } });
    expect(student.accountId).toBe(teacher.accountId);
    // The other address's ticket was never spent — a session always wins,
    // it doesn't consume what it beats.
    expect(await prisma.student.findUnique({ where: { email: otherEmail } })).toBeNull();
  });

  // PR #427 review, C1, Scenario B: the same race WITH a body supplied used
  // to let the ticket branch win outright, creating a new account for the
  // ticket's address and silently replacing the caller's own session.
  it('ignores a live signup-ticket cookie and a supplied body when a session is present, rather than switching accounts', async () => {
    const email = `profile-session-switch-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'NoSwitch',
        lastName: 'Teacher',
        email,
        bio: 'Fixture for PR #427 review finding C1 (scenario B)',
        pageSlug: `profile-session-switch-${suffix}`,
        account: { create: { email } },
      },
    });
    const rawSession = await seedSession(prisma, teacher.accountId);

    const otherEmail = `profile-session-switch-other-${suffix}@test.local`;
    const liveTicket = await mintSignupTicket(prisma, otherEmail, 'student');

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_session=${rawSession}; fair_yoga_signup=${liveTicket}`,
        ...freshIp(),
      },
      body: JSON.stringify({ firstName: 'Evil', lastName: 'Switch' }),
    });

    expect(res.status).toBe(201);
    // Session-path success carries no new session cookie — the caller's own
    // session was never replaced.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
    const student = await prisma.student.findUniqueOrThrow({ where: { email } });
    expect(student.accountId).toBe(teacher.accountId);
    expect(await prisma.student.findUnique({ where: { email: otherEmail } })).toBeNull();
  });

  it('clears the stray ticket cookie it declined to honour', async () => {
    const email = `profile-session-clear-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Clear',
        lastName: 'Cookie',
        email,
        bio: 'Fixture for the stale-cookie clear',
        pageSlug: `profile-session-clear-${suffix}`,
        account: { create: { email } },
      },
    });
    const rawSession = await seedSession(prisma, teacher.accountId);
    const otherEmail = `profile-session-clear-other-${suffix}@test.local`;
    const liveTicket = await mintSignupTicket(prisma, otherEmail, 'student');

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: {
        Cookie: `fair_yoga_session=${rawSession}; fair_yoga_signup=${liveTicket}`,
        ...freshIp(),
      },
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });
});
