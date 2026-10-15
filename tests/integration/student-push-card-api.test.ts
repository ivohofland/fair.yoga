import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, uniqueSuffix, cookie, seedSession } from '../helpers';
import { expectApplied, expectUnchanged } from '../api-assertions';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const URL_ = `${BASE_URL}/api/account/student-push-card`;

const studentEmail = `push-card-student-${suffix}@test.local`;
const teacherOnlyEmail = `push-card-teacher-${suffix}@test.local`;
const bothEmail = `push-card-both-${suffix}@test.local`;

let studentId: string;
let studentAccountId: string;
let studentToken: string;
let teacherOnlyAccountId: string;
let teacherOnlyToken: string;
let bothAccountId: string;
let bothTeacherId: string;
let bothStudentId: string;
let bothToken: string;

beforeAll(async () => {
  await prisma.$connect();
  const student = await prisma.student.create({
    data: {
      firstName: 'Card',
      lastName: 'Student',
      email: studentEmail,
      claimedAt: new Date(),
      account: { create: { email: studentEmail } },
    },
  });
  studentId = student.id;
  studentAccountId = student.accountId!;
  studentToken = await seedSession(prisma, studentAccountId);

  const teacherOnly = await prisma.teacher.create({
    data: {
      firstName: 'Card',
      lastName: 'Teacher',
      email: teacherOnlyEmail,
      bio: '',
      pageSlug: `push-card-teacher-${suffix}`,
      account: { create: { email: teacherOnlyEmail } },
    },
  });
  teacherOnlyAccountId = teacherOnly.accountId;
  teacherOnlyToken = await seedSession(prisma, teacherOnlyAccountId);

  const both = await prisma.account.create({ data: { email: bothEmail }, select: { id: true } });
  bothAccountId = both.id;
  const bothTeacher = await prisma.teacher.create({
    data: {
      firstName: 'Both',
      lastName: 'Hats',
      email: bothEmail,
      bio: '',
      pageSlug: `push-card-both-${suffix}`,
      accountId: bothAccountId,
    },
  });
  bothTeacherId = bothTeacher.id;
  const bothStudent = await prisma.student.create({
    data: {
      firstName: 'Both',
      lastName: 'Hats',
      email: bothEmail,
      claimedAt: new Date(),
      accountId: bothAccountId,
    },
  });
  bothStudentId = bothStudent.id;
  bothToken = await seedSession(prisma, bothAccountId);
});

afterAll(async () => {
  const accountIds = [studentAccountId, teacherOnlyAccountId, bothAccountId];
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

function post(path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: {
      ...(token ? cookie(token) : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/account/student-push-card', () => {
  it('records the dismissal, then answers unchanged on a repeat', async () => {
    const first = await post(URL_, studentToken);
    expect(await expectApplied(first)).toEqual({ dismissed: true });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).dismissedPushCard).toBe(true);

    const second = await post(URL_, studentToken);
    expect(await expectUnchanged(second)).toEqual({ dismissed: true });
    expect((await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).dismissedPushCard).toBe(true);
  });

  it('refuses a teacher-only session with 403', async () => {
    expect((await post(URL_, teacherOnlyToken)).status).toBe(403);
  });

  it('refuses an unauthenticated request with 401', async () => {
    expect((await post(URL_)).status).toBe(401);
  });

  it('keeps the student and teacher dismissals of one account apart', async () => {
    const res = await post(URL_, bothToken);
    expect(res.status).toBe(200);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: bothStudentId } })).dismissedPushCard).toBe(true);
    expect((await prisma.teacher.findUniqueOrThrow({ where: { id: bothTeacherId } })).skippedOnboarding).toEqual([]);

    await prisma.student.update({ where: { id: bothStudentId }, data: { dismissedPushCard: false } });
    const skip = await post(`${BASE_URL}/api/account/onboarding`, bothToken, { step: 'push' });
    expect(skip.status).toBe(200);
    expect((await prisma.teacher.findUniqueOrThrow({ where: { id: bothTeacherId } })).skippedOnboarding).toEqual(['push']);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: bothStudentId } })).dismissedPushCard).toBe(false);
  });
});
