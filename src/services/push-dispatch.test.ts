import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, type NotificationType } from '@prisma/client';
import { dispatchPushes, PUSH_STALE_AFTER_MS, type PushSender } from './push-dispatch';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function recordingSender(outcome: 'delivered' | 'gone' | 'failed' = 'delivered') {
  const calls: Array<{ endpoint: string; title: string; body: string; url: string; urgency: string }> = [];
  const send: PushSender = vi.fn(async (target, payload, urgency) => {
    calls.push({ endpoint: target.endpoint, ...payload, urgency });
    return { outcome, status: outcome === 'delivered' ? 201 : outcome === 'gone' ? 410 : 500 };
  });
  return { send, calls };
}

async function subscribe(accountId: string, tag: string) {
  return prisma.pushSubscription.create({
    data: { accountId, endpoint: `https://push.invalid/${tag}-${crypto.randomUUID()}`, p256dh: 'unused-by-fake', auth: 'unused' },
  });
}

const notificationIds: string[] = [];

async function notify(data: { recipientType: 'student' | 'teacher'; recipientId: string; type: NotificationType; createdAt?: Date; title?: string; body?: string }) {
  const n = await prisma.notification.create({ data: { title: 'T', body: 'B', ...data } });
  notificationIds.push(n.id);
  return n;
}

function scoped(ids: string[]) {
  return scopeSweep(prisma, { Notification: { id: { in: ids } } });
}

describe('dispatchPushes', () => {
  let studentId: string;
  let studentAccountId: string;
  let teacherId: string;
  let teacherAccountId: string;
  let dualAccountId: string;
  let dualStudentId: string;
  let dualTeacherId: string;
  let unclaimedStudentId: string;
  let erasedAccountId: string;
  let erasedStudentId: string;

  // Keyed arrays filled in beforeAll as each row is created, so a partial
  // failure there still leaves afterAll something safe to clean up — an
  // unguarded `in: []`/`in: undefined` filter deletes the whole table.
  const accountIds: string[] = [];
  const studentIds: string[] = [];
  const teacherIds: string[] = [];

  beforeAll(async () => {
    const studentAccount = await prisma.account.create({
      data: { email: `push-student-${uniqueSuffix}@test.local` },
    });
    studentAccountId = studentAccount.id;
    accountIds.push(studentAccountId);
    const student = await prisma.student.create({
      data: {
        accountId: studentAccountId,
        claimedAt: new Date(),
        firstName: 'Push',
        lastName: 'Student',
        email: `push-student-${uniqueSuffix}@test.local`,
      },
    });
    studentId = student.id;
    studentIds.push(studentId);

    const teacherAccount = await prisma.account.create({
      data: { email: `push-teacher-${uniqueSuffix}@test.local` },
    });
    teacherAccountId = teacherAccount.id;
    accountIds.push(teacherAccountId);
    const teacher = await prisma.teacher.create({
      data: {
        accountId: teacherAccountId,
        firstName: 'Push',
        lastName: 'Teacher',
        email: `push-teacher-${uniqueSuffix}@test.local`,
        bio: 'Push dispatch tests',
        pageSlug: `push-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    teacherIds.push(teacherId);

    const dualAccount = await prisma.account.create({
      data: { email: `push-dual-${uniqueSuffix}@test.local` },
    });
    dualAccountId = dualAccount.id;
    accountIds.push(dualAccountId);
    const dualStudent = await prisma.student.create({
      data: {
        accountId: dualAccountId,
        claimedAt: new Date(),
        firstName: 'Dual',
        lastName: 'Student',
        email: `push-dual-student-${uniqueSuffix}@test.local`,
      },
    });
    dualStudentId = dualStudent.id;
    studentIds.push(dualStudentId);
    const dualTeacher = await prisma.teacher.create({
      data: {
        accountId: dualAccountId,
        firstName: 'Dual',
        lastName: 'Teacher',
        email: `push-dual-teacher-${uniqueSuffix}@test.local`,
        bio: 'Push dispatch dual-role tests',
        pageSlug: `push-dual-teacher-${uniqueSuffix}`,
      },
    });
    dualTeacherId = dualTeacher.id;
    teacherIds.push(dualTeacherId);

    const unclaimedStudent = await prisma.student.create({
      data: {
        accountId: null,
        firstName: 'Unclaimed',
        lastName: 'Student',
        email: `push-unclaimed-${uniqueSuffix}@test.local`,
      },
    });
    unclaimedStudentId = unclaimedStudent.id;
    studentIds.push(unclaimedStudentId);

    // Real erasure shape (R10): `deletedAt` set, `accountId` KEPT — that is
    // what `src/services/gdpr.ts` erasure leaves (see `eraseStudent`).
    const erasedAccount = await prisma.account.create({
      data: { email: `push-erased-${uniqueSuffix}@test.local` },
    });
    erasedAccountId = erasedAccount.id;
    accountIds.push(erasedAccountId);
    const erasedStudent = await prisma.student.create({
      data: {
        accountId: erasedAccountId,
        claimedAt: new Date(),
        firstName: 'Deleted',
        lastName: 'Student',
        email: `push-erased-deleted-${uniqueSuffix}@test.local`,
        deletedAt: new Date(),
      },
    });
    erasedStudentId = erasedStudent.id;
    studentIds.push(erasedStudentId);
  });

  // The fixture accounts are shared across every test in this file, and
  // `dispatchPushes` reads ALL PushSubscription rows for an account — so a
  // subscription left behind by one test would be delivered to by the next
  // one's send. Each test creates exactly the subscriptions it asserts on.
  afterEach(async () => {
    if (accountIds.length > 0) {
      await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
    }
  });

  afterAll(async () => {
    if (notificationIds.length > 0) {
      await prisma.notification.deleteMany({ where: { id: { in: notificationIds } } });
    }
    if (accountIds.length > 0) {
      await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    if (studentIds.length > 0) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (teacherIds.length > 0) {
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    }
    if (accountIds.length > 0) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  it('pushes a default-on student group to every device on the account and marks the row handled', async () => {
    const a = await subscribe(studentAccountId, 'a');
    const b = await subscribe(studentAccountId, 'b');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const { send, calls } = recordingSender();
    const s = scoped([n.id]);
    await dispatchPushes(s.db, send);
    expect(s.rowsRead('Notification')).toBeGreaterThan(0);
    expect(calls.map((c) => c.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
    expect(calls[0]).toMatchObject({ url: `/updates?n=${n.id}`, urgency: 'high' });
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(after.pushHandledAt).not.toBeNull();
    expect(after.isRead).toBe(false);
    expect(after.emailSent).toBe(false);
  });

  it('never pushes a notification whose transaction rolled back', async () => {
    await subscribe(studentAccountId, 'rb');
    let rolledBackId = '';
    await expect(prisma.$transaction(async (tx) => {
      const n = await tx.notification.create({ data: { recipientType: 'student', recipientId: studentId, type: 'spot_available', title: 'T', body: 'B' } });
      rolledBackId = n.id;
      const { send, calls } = recordingSender();
      await dispatchPushes(scoped([n.id]).db, send); // a concurrent tick while the writer is uncommitted
      expect(calls).toHaveLength(0);
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(await prisma.notification.findUnique({ where: { id: rolledBackId } })).toBeNull();
  });

  it('retires a row past the stale cutoff without sending', async () => {
    await subscribe(studentAccountId, 'stale');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(Date.now() - PUSH_STALE_AFTER_MS - 1000) });
    const { send, calls } = recordingSender();
    await dispatchPushes(scoped([n.id]).db, send);
    expect(calls).toHaveLength(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
  });

  it('honours an off group, and never pushes a student their own booking', async () => {
    await subscribe(studentAccountId, 'prefs');
    const optional = await notify({ recipientType: 'student', recipientId: studentId, type: 'announcement' });
    const own = await notify({ recipientType: 'student', recipientId: studentId, type: 'booking_confirmed' });
    const { send, calls } = recordingSender();
    await dispatchPushes(scoped([optional.id, own.id]).db, send);
    expect(calls).toHaveLength(0);
    for (const id of [optional.id, own.id]) {
      expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).pushHandledAt).not.toBeNull();
    }
  });

  it('redacts the money body on the lock screen', async () => {
    await prisma.student.update({ where: { id: studentId }, data: { pushPayments: true } });
    await subscribe(studentAccountId, 'money');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'payment_request', body: 'Your price is €14.20.' });
    const { send, calls } = recordingSender();
    await dispatchPushes(scoped([n.id]).db, send);
    expect(calls[0]!.body).toBe('Open fair.yoga to see the details.');
  });

  it('deletes a subscription the push service reports gone, and does not retry a failure', async () => {
    const gone = await subscribe(teacherAccountId, 'gone');
    const n = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });
    await dispatchPushes(scoped([n.id]).db, recordingSender('gone').send);
    expect(await prisma.pushSubscription.findUnique({ where: { id: gone.id } })).toBeNull();

    const kept = await subscribe(teacherAccountId, 'fail');
    const m = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });
    const failing = recordingSender('failed');
    await dispatchPushes(scoped([m.id]).db, failing.send);
    await dispatchPushes(scoped([m.id]).db, failing.send);
    expect(failing.calls).toHaveLength(1);
    expect(await prisma.pushSubscription.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  it('sends once when two ticks overlap', async () => {
    await subscribe(studentAccountId, 'overlap');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'waitlist_promoted' });
    const { send, calls } = recordingSender();
    await Promise.all([dispatchPushes(scoped([n.id]).db, send), dispatchPushes(scoped([n.id]).db, send)]);
    expect(calls.filter((c) => c.title === 'T')).toHaveLength(1);
  });

  it('reaches a dual-role account for both profiles, each by its own prefs', async () => {
    const device = await subscribe(dualAccountId, 'dual');
    const asStudent = await notify({ recipientType: 'student', recipientId: dualStudentId, type: 'spot_available' });
    const asTeacher = await notify({ recipientType: 'teacher', recipientId: dualTeacherId, type: 'class_cancelled' });
    const { send, calls } = recordingSender();
    await dispatchPushes(scoped([asStudent.id, asTeacher.id]).db, send);
    expect(calls.map((c) => c.url).sort()).toEqual([`/inbox?n=${asTeacher.id}`, `/updates?n=${asStudent.id}`].sort());
    expect(new Set(calls.map((c) => c.endpoint))).toEqual(new Set([device.endpoint]));
  });

  it('retires without sending for an unclaimed student and for an erased profile', async () => {
    const unclaimed = await notify({ recipientType: 'student', recipientId: unclaimedStudentId, type: 'walk_in_added' });
    const missing = await notify({ recipientType: 'student', recipientId: crypto.randomUUID(), type: 'spot_available' });
    await subscribe(erasedAccountId, 'erased');
    const erased = await notify({ recipientType: 'student', recipientId: erasedStudentId, type: 'spot_available' });
    const { send, calls } = recordingSender();
    await expect(dispatchPushes(scoped([unclaimed.id, missing.id, erased.id]).db, send)).resolves.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it('retires rows without sending when push is not configured', async () => {
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const result = await dispatchPushes(scoped([n.id]).db, null);
    expect(result.sent).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
  });
});
