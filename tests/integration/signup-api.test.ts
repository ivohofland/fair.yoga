import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * Profile-attachment rules: an unauthenticated signup must never attach a
 * profile to an existing account (that requires an authenticated session),
 * and fresh signups create the account atomically with the profile.
 */

const takenEmail = `signup-taken-${suffix}@test.local`;
const teacherOnlyEmail = `signup-teacheronly-${suffix}@test.local`;
const unclaimedEmail = `signup-unclaimed-${suffix}@test.local`;

let takenStudentId: string;
let unclaimedStudentId: string;

beforeAll(async () => {
  await prisma.$connect();
  const student = await prisma.student.create({
    data: {
      firstName: 'Taken',
      lastName: 'Student',
      email: takenEmail,
      claimedAt: new Date(),
      account: { create: { email: takenEmail } },
    },
  });
  takenStudentId = student.id;

  const unclaimed = await prisma.student.create({
    data: { firstName: 'CRM', lastName: 'Contact', email: unclaimedEmail },
  });
  unclaimedStudentId = unclaimed.id;

  await prisma.teacher.create({
    data: {
      firstName: 'Solo',
      lastName: 'Teacher',
      email: teacherOnlyEmail,
      bio: 'Teacher-only fixtures',
      pageSlug: `signup-teacheronly-${suffix}`,
      account: { create: { email: teacherOnlyEmail } },
    },
  });
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.student.deleteMany({
    where: { id: { in: [takenStudentId, unclaimedStudentId] } },
  });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

describe('POST /api/teachers', () => {
  it('rejects an email that already owns an account (student profile counts)', async () => {
    const res = await fetch(`${BASE_URL}/api/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'Grab',
        lastName: 'Attempt',
        email: takenEmail,
        bio: 'Should not exist',
        pageSlug: `signup-grab-${suffix}`,
      }),
    });

    expect(res.status).toBe(409);
    // No shadowing teacher, no second account.
    expect(await prisma.teacher.count({ where: { email: takenEmail } })).toBe(0);
    expect(await prisma.account.count({ where: { email: takenEmail } })).toBe(1);
  });

  it('creates account + teacher atomically for a fresh email', async () => {
    const email = `signup-fresh-teacher-${suffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'Fresh',
        lastName: 'Teacher',
        email,
        bio: 'Signup fixtures',
        pageSlug: `signup-fresh-${suffix}`,
      }),
    });

    expect(res.status).toBe(201);
    const teacher = await prisma.teacher.findUnique({
      where: { email },
      include: { account: true },
    });
    expect(teacher).not.toBeNull();
    expect(teacher!.account.email).toBe(email);
  });
});

describe('POST /api/auth/student-signup', () => {
  it('creates account + claimed student for a fresh email', async () => {
    const email = `signup-fresh-student-${suffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'Fresh', lastName: 'Student', email }),
    });

    expect(res.status).toBe(200);
    const student = await prisma.student.findUnique({ where: { email } });
    expect(student).not.toBeNull();
    expect(student!.claimedAt).not.toBeNull();
    expect(student!.accountId).not.toBeNull();
    expect(await prisma.account.count({ where: { email } })).toBe(1);
  });

  it('does not create an account for an unclaimed CRM email — claim happens at verify', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'C', lastName: 'C', email: unclaimedEmail }),
    });

    expect(res.status).toBe(200);
    expect(await prisma.account.count({ where: { email: unclaimedEmail } })).toBe(0);
    const student = await prisma.student.findUnique({ where: { email: unclaimedEmail } });
    expect(student!.claimedAt).toBeNull();
  });

  it('does not attach a student profile to a teacher-only account either', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'T', lastName: 'T', email: teacherOnlyEmail }),
    });

    expect(res.status).toBe(200);
    expect(await prisma.student.count({ where: { email: teacherOnlyEmail } })).toBe(0);
  });

  it('does not attach a student profile to an existing account', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ firstName: 'T', lastName: 'T', email: takenEmail }),
    });

    // Same 200 as every other outcome — no account enumeration.
    expect(res.status).toBe(200);
    expect(await prisma.student.count({ where: { email: takenEmail } })).toBe(1);
    expect(await prisma.account.count({ where: { email: takenEmail } })).toBe(1);
  });
});


describe('POST /api/auth/magic-link/verify — the claim moment over HTTP', () => {
  it('claims an unclaimed CRM student: account, cookie, and /bookings landing', async () => {
    const token = await generateMagicLinkToken(prisma, unclaimedEmail);

    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_session=');
    const body = (await res.json()) as { data: { redirectTo: string } };
    expect(body.data.redirectTo).toBe('/bookings');

    const student = await prisma.student.findUniqueOrThrow({
      where: { id: unclaimedStudentId },
    });
    expect(student.claimedAt).not.toBeNull();
    expect(student.accountId).not.toBeNull();
  });
});

/**
 * `freshIp()` is what makes this suite re-runnable: a fresh bucket per request
 * means no per-IP limit is ever reached. That rests entirely on consecutive
 * calls differing, and nothing else in the repository would fail if they
 * stopped — the symptom is a 429 on the *second* full sweep, an hour of
 * confusion away from the cause. So assert it directly.
 *
 * 100,000 draws, and the count is the point — do not "optimise" it back down.
 * The implementation this one replaced drew its first octet once, at module
 * load (`const ipOctet = randomInt(256)`), then varied only the low two
 * octets per call (`` `10.${ipOctet}.${(n >> 8) & 0xff}.${n & 0xff}` ``) —
 * those two octets repeat every 2^16 = 65,536 calls, so with the octet fixed
 * it could never emit more than 65,536 distinct addresses. That ceiling was
 * invisible at 100 draws (n = 0..99 alone is already distinct) but caused a
 * real 429 during this branch's work. 100,000 exceeds 65,536, so it fails
 * against that implementation and pins the 2^24 (16.7M)-wide space the
 * helper's docblock claims.
 *
 * It costs no rate-limit budget and issues no HTTP: the addresses are computed
 * and counted in-process, never sent. That is also why this is the only test
 * safe to run under a temporary mutation of `freshIp()` — see the warning in
 * `tests/helpers.ts`.
 */
describe('freshIp', () => {
  it('yields a distinct address on every call', () => {
    const seen = new Set(Array.from({ length: 100_000 }, () => freshIp()['x-forwarded-for']));
    expect(seen.size).toBe(100_000);
  });

  it('is a private-range address, so one in a log is obviously synthetic', () => {
    expect(freshIp()['x-forwarded-for']).toMatch(/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });
});

/**
 * The only test that fails if the per-IP limiter is removed from
 * `POST /api/auth/student-signup`. Every other call site in the suite now sends
 * a fresh address (see `freshIp`), which is what keeps the suite re-runnable —
 * and which would otherwise leave this limiter with no coverage at all.
 *
 * One address for all six requests, deliberately: that is the bucket under
 * test. Six DISTINCT emails, also deliberately — the route's other budget is
 * per-email (3 per 15 min), and repeating an address would let that one produce
 * the 429 instead, which would keep this test green with the IP check deleted.
 */
describe('POST /api/auth/student-signup — per-IP budget', () => {
  it('refuses the sixth signup from one address within the hour', async () => {
    const ip = freshIp();
    const statuses: number[] = [];

    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ip },
        body: JSON.stringify({
          firstName: 'Burst',
          lastName: 'Signup',
          email: `signup-ip-burst-${i}-${suffix}@test.local`,
        }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual(Array(5).fill(200));
    expect(statuses[5]).toBe(429);
  });
});
