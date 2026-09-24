import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { STUDENT_INVITATION_PATH, TEACHER_INVITATION_PATH } from '@/lib/notification-links';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * GET /api/notifications — the keyset-paged inbox read. One `Account` carries a
 * Teacher and a Student; a second, unrelated teacher account is the foreign
 * recipient a cursor must never reach.
 */

const dualEmail = `notiflist-dual-${suffix}@test.local`;
const otherEmail = `notiflist-other-${suffix}@test.local`;

let dualAccountId: string;
let dualTeacherId: string;
let dualStudentId: string;
let dualToken: string;
let otherAccountId: string;
let otherTeacherId: string;
let otherToken: string;
let teacherInvitationRowId: string;
let studentInvitationRowId: string;

// T sits a minute in the past at a whole second, so the tie group shares one
// exact instant. It is derived from now because the daily cleanup reaps rows a
// year past their createdAt, which a fixed date would eventually be.
const T = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
const at = (offsetSeconds: number) => new Date(T.getTime() + offsetSeconds * 1000);

// The teacher hat's rows, newest first: a newer group, a tie group at exactly
// T, an older group, then the teacher_invitation row seeded below.
const NEWER = 3;
const TIE = 5;
const OLDER = 2;
const TEACHER_TOTAL = NEWER + TIE + OLDER + 1;
// One row past the newer group, so the first page boundary falls inside the tie group.
const WALK_LIMIT = NEWER + 1;

type Page = {
  notifications: Array<{ id: string; recipientType: string; recipientId: string }>;
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
};

const authed = (path: string, token: string) =>
  fetch(`${BASE_URL}${path}`, { headers: cookie(token) });

async function getPage(token: string, query: string): Promise<{ status: number; page: Page }> {
  const res = await authed(`/api/notifications?${query}`, token);
  const body = (await res.json()) as { data: Page };
  return { status: res.status, page: body.data };
}

function seedRows(
  recipientType: 'teacher' | 'student',
  recipientId: string,
  createdAt: Date,
  count: number,
  type: 'announcement' | 'teacher_invitation' = 'announcement',
) {
  return Array.from({ length: count }, (_, i) => ({
    recipientType,
    recipientId,
    type,
    title: `${recipientType} ${createdAt.getTime()} #${i}`,
    body: 'seeded',
    createdAt,
  }));
}

beforeAll(async () => {
  await prisma.$connect();

  const dualTeacher = await prisma.teacher.create({
    data: {
      firstName: 'NotifList',
      lastName: 'Dual',
      email: dualEmail,
      bio: 'Notification list fixtures',
      pageSlug: `notiflist-dual-${suffix}`,
      account: { create: { email: dualEmail } },
    },
  });
  dualTeacherId = dualTeacher.id;
  dualAccountId = dualTeacher.accountId;
  const dualStudent = await prisma.student.create({
    data: {
      firstName: 'NotifList',
      lastName: 'DualStudent',
      email: dualEmail,
      incomeTier: 3,
      claimedAt: new Date(),
      accountId: dualAccountId,
    },
  });
  dualStudentId = dualStudent.id;
  dualToken = await seedSession(prisma, dualAccountId);

  const otherTeacher = await prisma.teacher.create({
    data: {
      firstName: 'NotifList',
      lastName: 'Other',
      email: otherEmail,
      bio: 'Notification list fixtures',
      pageSlug: `notiflist-other-${suffix}`,
      account: { create: { email: otherEmail } },
    },
  });
  otherTeacherId = otherTeacher.id;
  otherAccountId = otherTeacher.accountId;
  otherToken = await seedSession(prisma, otherAccountId);

  await prisma.notification.createMany({
    data: [
      ...seedRows('teacher', dualTeacherId, at(2), NEWER),
      ...seedRows('teacher', dualTeacherId, at(0), TIE),
      ...seedRows('teacher', dualTeacherId, at(-2), OLDER),
    ],
  });
  // Student hat, plus one invitation on each hat for the href test.
  await prisma.notification.createMany({
    data: seedRows('student', dualStudentId, at(-30), 2),
  });
  const teacherInvitation = await prisma.notification.create({
    data: { ...seedRows('teacher', dualTeacherId, at(-60), 1, 'teacher_invitation')[0]! },
  });
  teacherInvitationRowId = teacherInvitation.id;
  const studentInvitation = await prisma.notification.create({
    data: { ...seedRows('student', dualStudentId, at(-61), 1, 'teacher_invitation')[0]! },
  });
  studentInvitationRowId = studentInvitation.id;

  await prisma.notification.createMany({
    data: [
      ...seedRows('teacher', otherTeacherId, at(1), 2),
      ...seedRows('teacher', otherTeacherId, at(-1), 2),
    ],
  });
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { recipientId: { in: [dualTeacherId, dualStudentId, otherTeacherId] } },
  });
  await prisma.session.deleteMany({ where: { accountId: { in: [dualAccountId, otherAccountId] } } });
  await prisma.student.deleteMany({ where: { id: dualStudentId } });
  await prisma.teacher.deleteMany({ where: { id: { in: [dualTeacherId, otherTeacherId] } } });
  await prisma.account.deleteMany({ where: { id: { in: [dualAccountId, otherAccountId] } } });
  await prisma.$disconnect();
});

describe('GET /api/notifications — keyset paging', () => {
  it('walks a tie group straddling the boundary without repeat or gap', async () => {
    const expected = (
      await prisma.notification.findMany({
        where: { recipientType: 'teacher', recipientId: dualTeacherId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).map((n) => n.id);
    expect(expected).toHaveLength(TEACHER_TOTAL);

    const ids: string[] = [];
    let requests = 0;
    let cursor: string | null = null;
    do {
      const query: string = `recipientType=teacher&limit=${WALK_LIMIT}${
        cursor === null ? '' : `&before=${encodeURIComponent(cursor)}`
      }`;
      const { status, page } = await getPage(dualToken, query);
      expect(status).toBe(200);
      ids.push(...page.notifications.map((n) => n.id));
      cursor = page.nextCursor;
      requests += 1;
    } while (cursor !== null && requests < 10);

    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(ids.length);
    expect(requests).toBe(Math.ceil(TEACHER_TOTAL / WALK_LIMIT));
  });

  it('answers an exact fit without a next page', async () => {
    const exact = await getPage(dualToken, `recipientType=teacher&limit=${TEACHER_TOTAL}`);
    expect(exact.page.notifications).toHaveLength(TEACHER_TOTAL);
    expect(exact.page.nextCursor).toBeNull();

    const short = await getPage(dualToken, `recipientType=teacher&limit=${TEACHER_TOTAL - 1}`);
    expect(short.page.notifications).toHaveLength(TEACHER_TOTAL - 1);
    expect(short.page.nextCursor).not.toBeNull();
  });

  it('returns bare notification rows, without the relatedClass join', async () => {
    const { page } = await getPage(dualToken, 'limit=100');
    expect(page.notifications.length).toBeGreaterThan(0);
    for (const n of page.notifications) {
      expect(n).not.toHaveProperty('relatedClass');
    }
  });

  it('narrows a dual-role account to the requested hat', async () => {
    const student = await getPage(dualToken, 'recipientType=student&limit=100');
    expect(student.page.notifications.length).toBeGreaterThan(0);
    expect(student.page.notifications.every((n) => n.recipientType === 'student')).toBe(true);

    const teacher = await getPage(dualToken, 'recipientType=teacher&limit=100');
    expect(teacher.page.notifications.length).toBeGreaterThan(0);
    expect(teacher.page.notifications.every((n) => n.recipientType === 'teacher')).toBe(true);

    const both = await getPage(dualToken, 'limit=100');
    const types = new Set(both.page.notifications.map((n) => n.recipientType));
    expect(types).toEqual(new Set(['teacher', 'student']));
  });

  it('computes hrefById per row from that row’s own hat', async () => {
    const { page } = await getPage(dualToken, 'limit=100');
    expect(page.hrefById[studentInvitationRowId]).toBe(STUDENT_INVITATION_PATH);
    expect(page.hrefById[teacherInvitationRowId]).toBe(TEACHER_INVITATION_PATH);
  });

  it('does not treat a cursor as an authorization token', async () => {
    const foreign = await getPage(otherToken, 'limit=1');
    expect(foreign.page.nextCursor).not.toBeNull();
    const foreignIds = new Set(foreign.page.notifications.map((n) => n.id));
    expect(foreignIds.size).toBe(1);

    const { status, page } = await getPage(
      dualToken,
      `before=${encodeURIComponent(foreign.page.nextCursor!)}&limit=100`,
    );
    expect(status).toBe(200);
    expect(page.notifications.length).toBeGreaterThan(0);
    for (const n of page.notifications) {
      expect([dualTeacherId, dualStudentId]).toContain(n.recipientId);
      expect(n.recipientId).not.toBe(otherTeacherId);
    }
  });

  it.each([
    ['a malformed cursor', 'before=garbage'],
    ['an empty cursor', 'before='],
    ['a bad recipientType', 'recipientType=admin'],
  ])('refuses %s with 400', async (_label, query) => {
    const res = await authed(`/api/notifications?${query}`, dualToken);
    expect(res.status).toBe(400);
  });

  it('degrades a non-numeric limit and clamps a zero one', async () => {
    const garbage = await authed('/api/notifications?limit=abc', dualToken);
    expect(garbage.status).toBe(200);

    const zero = await getPage(dualToken, 'limit=0');
    expect(zero.status).toBe(200);
    expect(zero.page.notifications).toHaveLength(1);
  });

  it('rejects a request with no session', async () => {
    const res = await fetch(`${BASE_URL}/api/notifications`);
    expect(res.status).toBe(401);
  });
});
