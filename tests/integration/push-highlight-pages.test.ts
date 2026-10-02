import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * A push tap lands on `/updates?n=<id>` (student) or `/inbox?n=<id>`
 * (teacher). The row it names is marked `aria-current="true"`; a repeated
 * `n` names no row.
 */
describe('inbox pages highlight the row a push named', () => {
  const accountIds: string[] = [];
  const notificationIds: string[] = [];
  let studentId: string;
  let studentToken: string;
  let teacherId: string;
  let teacherToken: string;
  const studentRows: string[] = [];
  const teacherRows: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    const student = await prisma.student.create({
      data: {
        firstName: 'Highlight',
        lastName: 'Student',
        email: `push-highlight-${suffix}-s@test.local`,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: `push-highlight-${suffix}-s@test.local` } },
      },
    });
    studentId = student.id;
    accountIds.push(student.accountId!);
    studentToken = await seedSession(prisma, student.accountId!);

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Highlight',
        lastName: 'Teacher',
        email: `push-highlight-${suffix}-t@test.local`,
        bio: 'Push highlight test',
        pageSlug: `push-highlight-${suffix}`,
        account: { create: { email: `push-highlight-${suffix}-t@test.local` } },
      },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);
    teacherToken = await seedSession(prisma, teacher.accountId);

    for (const i of [0, 1]) {
      const s = await prisma.notification.create({
        data: { recipientType: 'student', recipientId: studentId, type: 'spot_available', title: `Student ${i}`, body: 'B' },
      });
      studentRows.push(s.id);
      const t = await prisma.notification.create({
        data: { recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled', title: `Teacher ${i}`, body: 'B' },
      });
      teacherRows.push(t.id);
      notificationIds.push(s.id, t.id);
    }
  });

  afterAll(async () => {
    if (notificationIds.length > 0) {
      await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    }
    if (accountIds.length > 0) {
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  /** The ids of the rows marked current: the row button id inside each `aria-current="true"` element. */
  async function currentRows(path: string, token: string): Promise<string[]> {
    const res = await fetch(`${BASE_URL}${path}`, { headers: cookie(token), redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    const marked = html.split('aria-current="true"').slice(1);
    return marked.map((after) => /id="notification-row-([^"]+)"/.exec(after)?.[1] ?? '(no row id)');
  }

  it('marks the named row on /updates, and only that row', async () => {
    expect(await currentRows(`/updates?n=${studentRows[0]}`, studentToken)).toEqual([studentRows[0]]);
  });

  it('marks the named row on /inbox, and only that row', async () => {
    expect(await currentRows(`/inbox?n=${teacherRows[1]}`, teacherToken)).toEqual([teacherRows[1]]);
  });

  it('marks no row when n is repeated', async () => {
    expect(await currentRows(`/updates?n=${studentRows[0]}&n=${studentRows[1]}`, studentToken)).toEqual([]);
    expect(await currentRows(`/inbox?n=${teacherRows[0]}&n=${teacherRows[1]}`, teacherToken)).toEqual([]);
  });
});
