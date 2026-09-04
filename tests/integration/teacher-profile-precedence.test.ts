import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  const accountIds = (
    await prisma.account.findMany({ where: { email: { contains: suffix } }, select: { id: true } })
  ).map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  // Teacher before Account: Teacher.accountId has no cascade.
  await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

/** A signed-in account with a student profile and no teacher profile. */
async function seedStudentAccount(label: string) {
  const email = `${label}-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Signed',
      lastName: 'In',
      email,
      incomeTier: 3,
      claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  if (!student.accountId) throw new Error('fixture: student created without an account');
  const token = await seedSession(prisma, student.accountId);
  return { email, accountId: student.accountId, sessionToken: token };
}

function post(cookieHeader: string, body: unknown) {
  return fetch(`${BASE_URL}/api/account/teacher-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, ...freshIp() },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/teacher-profile — a session always beats a ticket (#428)', () => {
  it('creates the teacher on the SIGNED-IN account, not the ticket address', async () => {
    const me = await seedStudentAccount('tp-precedence-session');
    const ticketEmail = `tp-precedence-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=${me.sessionToken}; fair_yoga_signup=${ticket}`,
      {
        firstName: 'Session',
        lastName: 'Wins',
        bio: '',
        pageSlug: `tp-precedence-${suffix}`,
      },
    );

    expect(res.status).toBe(201);

    // The teacher hangs off the caller's own account.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { email: me.email } });
    expect(teacher.accountId).toBe(me.accountId);

    // No second account was minted for the ticket's address.
    const ticketAccount = await prisma.account.findUnique({ where: { email: ticketEmail } });
    expect(ticketAccount).toBeNull();

    // And the caller's session was not replaced.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
  });

  it('clears the declined ticket cookie on ALREADY_TEACHER, as the success paths do', async () => {
    const email = `tp-precedence-already-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Already', lastName: 'Teacher', email,
        bio: '', pageSlug: `tp-already-${suffix}`,
        account: { create: { email } },
      },
      select: { accountId: true },
    });
    const sessionToken = await seedSession(prisma, teacher.accountId);
    const ticket = await mintSignupTicket(
      prisma, `tp-precedence-already-ticket-${suffix}@test.local`, 'teacher',
    );

    const res = await post(
      `fair_yoga_session=${sessionToken}; fair_yoga_signup=${ticket}`,
      { firstName: 'No', lastName: 'Twice', bio: '', pageSlug: `tp-already-2-${suffix}` },
    );

    expect(res.status).toBe(409);
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });

  it('clears the stray ticket cookie it declined to honour', async () => {
    const me = await seedStudentAccount('tp-precedence-clear');
    const ticketEmail = `tp-precedence-clear-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=${me.sessionToken}; fair_yoga_signup=${ticket}`,
      { firstName: 'Clear', lastName: 'Cookie', bio: '', pageSlug: `tp-clear-${suffix}` },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');

    // The clear alone does not say the ticket was DECLINED: spending one
    // clears the same cookie, with the same header, so this assertion passed
    // against the route that honoured the ticket instead. What separates the
    // two is the row — a declined ticket is still there to be spent later —
    // and the absence of the session a spend would have minted.
    const declined = await prisma.magicLinkToken.findFirst({ where: { email: ticketEmail } });
    expect(declined).not.toBeNull();
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
  });

  it('clears a stray cookie that names a dead ticket the same as a live one', async () => {
    const me = await seedStudentAccount('tp-precedence-notcancelled');

    const res = await post(
      `fair_yoga_session=${me.sessionToken}; fair_yoga_signup=long-gone-token`,
      { firstName: 'Not', lastName: 'Cancelled', bio: '', pageSlug: `tp-notcancelled-${suffix}` },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });

  it('clears a declined stray ticket cookie on SLUG_TAKEN too, not only on success', async () => {
    const me = await seedStudentAccount('tp-precedence-slugtaken');
    const takenSlug = `tp-slugtaken-${suffix}`;
    await prisma.teacher.create({
      data: {
        firstName: 'Holds', lastName: 'TheSlug', email: `tp-slugholder-${suffix}@test.local`,
        bio: '', pageSlug: takenSlug, account: { create: { email: `tp-slugholder-${suffix}@test.local` } },
      },
    });
    const ticketEmail = `tp-precedence-slugtaken-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=${me.sessionToken}; fair_yoga_signup=${ticket}`,
      { firstName: 'Slug', lastName: 'Taken', bio: '', pageSlug: takenSlug },
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SLUG_TAKEN');
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });

  it('401s on an INVALID session cookie rather than spending the ticket', async () => {
    const ticketEmail = `tp-precedence-invalid-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=not-a-real-session-token; fair_yoga_signup=${ticket}`,
      { firstName: 'No', lastName: 'Entry', bio: '', pageSlug: `tp-invalid-${suffix}` },
    );

    // Presence, not validity — the ticket is never reached.
    expect(res.status).toBe(401);

    const still = await prisma.magicLinkToken.findFirst({ where: { email: ticketEmail } });
    expect(still).not.toBeNull();
  });

  it('still honours a ticket when no session cookie is present at all', async () => {
    const ticketEmail = `tp-precedence-ticketonly-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(`fair_yoga_signup=${ticket}`, {
      firstName: 'Ticket',
      lastName: 'Path',
      bio: '',
      pageSlug: `tp-ticketonly-${suffix}`,
    });

    expect(res.status).toBe(201);
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { email: ticketEmail } });
    expect(teacher.accountId).not.toBeNull();
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('fair_yoga_session=');
    expect(cookies).toContain('fair_yoga_signup=;');
  });
});
