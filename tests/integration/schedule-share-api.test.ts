import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, cookie, freshIp, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();

type Share = { key: string | null; weeks: number; includeStudio: boolean };

describe('/api/account/schedule-share (#916)', () => {
  const accountIds: string[] = [];
  let teacherId = '';
  let teacherToken = '';
  let studentToken = '';

  const call = (token: string, method: string, path = '', body?: unknown) =>
    fetch(`${BASE_URL}/api/account/schedule-share${path}`, {
      method,
      headers: { ...cookie(token), ...freshIp(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    await prisma.$connect();
    const email = `share-t-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Share', lastName: 'Teacher', email, bio: 'Share fixture',
        pageSlug: `share-${suffix}`, defaultTimezone: 'UTC', currency: 'EUR',
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);
    teacherToken = await seedSession(prisma, teacher.accountId);
    const sEmail = `share-s-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: { firstName: 'Share', lastName: 'Student', email: sEmail, account: { create: { email: sEmail } }, claimedAt: new Date(), incomeTier: 3 },
      select: { accountId: true },
    });
    accountIds.push(student.accountId as string);
    studentToken = await seedSession(prisma, student.accountId as string);
    // `next dev` compiles a route on its first request.
    await call(teacherToken, 'GET').catch(() => {});
    await call(teacherToken, 'POST', '/reset').catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('refuses a student session on every verb', async () => {
    for (const [method, path, body] of [
      ['GET', ''], ['POST', ''], ['PATCH', '', { weeks: 2 }], ['DELETE', ''], ['POST', '/reset'],
    ] as Array<[string, string, unknown?]>) {
      expect((await call(studentToken, method, path, body)).status, `${method} ${path}`).toBe(403);
    }
  });

  it('walks off -> on -> unchanged -> settings -> reset -> off', async () => {
    expect(((await expectApplied(await call(teacherToken, 'GET'))) as Share).key).toBeNull();
    await expectRefusal(await call(teacherToken, 'POST', '/reset'), 'SCHEDULE_SHARE_OFF');

    const on = (await expectApplied(await call(teacherToken, 'POST'))) as Share;
    expect(on.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(((await expectUnchanged(await call(teacherToken, 'POST'))) as Share).key).toBe(on.key);

    const patched = (await expectApplied(await call(teacherToken, 'PATCH', '', { weeks: 2, includeStudio: true }))) as Share;
    expect(patched).toEqual({ key: on.key, weeks: 2, includeStudio: true });

    const reset = (await expectApplied(await call(teacherToken, 'POST', '/reset'))) as Share;
    expect(reset.key).not.toBe(on.key);

    const off = (await expectApplied(await call(teacherToken, 'DELETE'))) as Share;
    expect(off.key).toBeNull();
    await expectUnchanged(await call(teacherToken, 'DELETE'));
  });

  it.each([[{ weeks: 5 }], [{ weeks: 0 }], [{ weeks: 1.5 }], [{ extra: true }]])('answers 400 for %j', async (body) => {
    expect((await call(teacherToken, 'PATCH', '', body)).status).toBe(400);
  });
});
