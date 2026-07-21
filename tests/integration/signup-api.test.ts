import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken } from '@/lib/auth';

const BASE_URL = 'http://localhost:3000';
const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}`;

/**
 * Profile-attachment rules: an unauthenticated signup must never attach a
 * profile to an existing account (that requires an authenticated session),
 * and fresh signups create the account atomically with the profile.
 */

const takenEmail = `signup-taken-${uniqueSuffix}@test.local`;
const teacherOnlyEmail = `signup-teacheronly-${uniqueSuffix}@test.local`;
const unclaimedEmail = `signup-unclaimed-${uniqueSuffix}@test.local`;

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
      pageSlug: `signup-teacheronly-${uniqueSuffix}`,
      account: { create: { email: teacherOnlyEmail } },
    },
  });
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: uniqueSuffix } } });
  await prisma.teacher.deleteMany({ where: { email: { contains: uniqueSuffix } } });
  await prisma.student.deleteMany({
    where: { id: { in: [takenStudentId, unclaimedStudentId] } },
  });
  await prisma.student.deleteMany({ where: { email: { contains: uniqueSuffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: uniqueSuffix } } });
  await prisma.$disconnect();
});

describe('POST /api/teachers', () => {
  it('rejects an email that already owns an account (student profile counts)', async () => {
    const res = await fetch(`${BASE_URL}/api/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Grab',
        lastName: 'Attempt',
        email: takenEmail,
        bio: 'Should not exist',
        pageSlug: `signup-grab-${uniqueSuffix}`,
      }),
    });

    expect(res.status).toBe(409);
    // No shadowing teacher, no second account.
    expect(await prisma.teacher.count({ where: { email: takenEmail } })).toBe(0);
    expect(await prisma.account.count({ where: { email: takenEmail } })).toBe(1);
  });

  it('creates account + teacher atomically for a fresh email', async () => {
    const email = `signup-fresh-teacher-${uniqueSuffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/teachers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Fresh',
        lastName: 'Teacher',
        email,
        bio: 'Signup fixtures',
        pageSlug: `signup-fresh-${uniqueSuffix}`,
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
    const email = `signup-fresh-student-${uniqueSuffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'T', lastName: 'T', email: teacherOnlyEmail }),
    });

    expect(res.status).toBe(200);
    expect(await prisma.student.count({ where: { email: teacherOnlyEmail } })).toBe(0);
  });

  it('does not attach a student profile to an existing account', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
