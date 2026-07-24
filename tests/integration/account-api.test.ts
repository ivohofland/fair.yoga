import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, createSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * The account-scoped routes on a teacher account that becomes dual:
 * joining as a student (including claiming an unclaimed CRM row with the
 * same email), the double-join 409, the dual export shape, and the dual
 * notifications feed.
 */

const email = `accapi-teacher-${suffix}@test.local`;

let accountId: string;
let teacherId: string;
let unclaimedStudentId: string;
let rawToken: string;

const authed = (path: string, init?: RequestInit) =>
  fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, ...cookie(rawToken) },
  });

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'AccApi',
      lastName: 'Teacher',
      email,
      bio: 'Account API fixtures',
      pageSlug: `accapi-${suffix}`,
      account: { create: { email } },
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  rawToken = await createSession(prisma, accountId);

  // The teacher already sits in someone's CRM as an unclaimed contact
  // under the same email — the join must claim this row, not collide.
  const unclaimed = await prisma.student.create({
    data: { firstName: 'Crm', lastName: 'Ghost', email },
  });
  unclaimedStudentId = unclaimed.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { recipientId: { in: [teacherId, unclaimedStudentId] } },
  });
  await prisma.session.deleteMany({ where: { accountId } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('POST /api/account/student-profile', () => {
  it('rejects when signed out', async () => {
    const res = await fetch(`${BASE_URL}/api/account/student-profile`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('claims the unclaimed CRM row with the account email instead of creating a duplicate', async () => {
    const res = await authed('/api/account/student-profile', { method: 'POST' });

    expect(res.status).toBe(201);
    const student = await prisma.student.findUniqueOrThrow({
      where: { id: unclaimedStudentId },
    });
    expect(student.accountId).toBe(accountId);
    expect(student.claimedAt).not.toBeNull();
    // No second Student row for this email.
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });

  it('rejects a second join with a machine-readable 409', async () => {
    const res = await authed('/api/account/student-profile', { method: 'POST' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string } };
    expect(body.error.code).toBe('ALREADY_STUDENT');
  });
});

describe('GET /api/account/export — dual account', () => {
  it('returns both sides under their own keys', async () => {
    const res = await authed('/api/account/export');

    expect(res.status).toBe(200);
    // The export is a raw JSON download (attachment), not a {data} envelope.
    const body = (await res.json()) as { teacher?: unknown; student?: unknown };
    expect(body.teacher).toBeDefined();
    expect(body.student).toBeDefined();
  });
});

describe('GET /api/notifications — dual account', () => {
  it('returns both profiles’ notifications with a combined total', async () => {
    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'Teacher-side note',
        body: 'For the teaching hat.',
      },
    });
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: unclaimedStudentId,
        type: 'booking_confirmed',
        title: 'Student-side note',
        body: 'For the student hat.',
      },
    });

    const res = await authed('/api/notifications');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { notifications: Array<{ title: string }>; total: number };
    };
    const titles = body.data.notifications.map((n) => n.title);
    expect(titles).toContain('Teacher-side note');
    expect(titles).toContain('Student-side note');
    expect(body.data.total).toBe(2);
  });
});
