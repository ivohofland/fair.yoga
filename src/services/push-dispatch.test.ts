import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, type NotificationType } from '@prisma/client';
import { dispatchPushes, PUSH_STALE_AFTER_MS, type PushSender } from './push-dispatch';
import { scopeSweep, type ScopedSweep } from '../../tests/scoped-sweep';
import { log } from '@/lib/log';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

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

/**
 * Resolves once two parties have arrived; a party calling it a third+ time
 * (or alone, past `timeoutMs`) gets a clear rejection instead of a hang.
 */
function twoPartyBarrier(timeoutMs = 2000): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived > 2) {
      throw new Error('twoPartyBarrier: called a third time — only two parties were expected');
    }
    if (arrived === 2) release();
    await Promise.race([
      bothArrived,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('twoPartyBarrier: timed out waiting for the second notification.findMany')),
          timeoutMs,
        );
      }),
    ]);
  };
}

/**
 * A scoped sweep whose `notification.findMany` does not return until a
 * second call has also read — staging the exact interleaving the claim's
 * CAS exists for. The hook goes on the base client, before `scopeSweep`
 * wraps it (`tests/scoped-sweep.ts`'s own docblock), and awaits the real
 * query before the barrier, so it delays the RESULT rather than the read —
 * no sleep, so it cannot serialize the two callers into never racing at all.
 */
function scopedRacing(ids: string[]): ScopedSweep {
  const wait = twoPartyBarrier();
  const racing = prisma.$extends({
    query: {
      notification: {
        async findMany({ args, query }) {
          const result = await query(args);
          await wait();
          return result;
        },
      },
    },
  });
  return scopeSweep(racing as unknown as PrismaClient, { Notification: { id: { in: ids } } });
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
  // failure there still leaves afterAll something safe to clean up: Prisma
  // treats `in: []` as matching no rows, and each cleanup below is guarded
  // by `.length > 0` only to skip that no-op query.
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

    // Real erasure shape: `deletedAt` set, `accountId` kept.
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
    try {
      await subscribe(studentAccountId, 'money');
      const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'payment_request', body: 'Your price is €14.20.' });
      const { send, calls } = recordingSender();
      await dispatchPushes(scoped([n.id]).db, send);
      expect(calls[0]!.body).toBe('Open fair.yoga to see the details.');
    } finally {
      await prisma.student.update({ where: { id: studentId }, data: { pushPayments: false } });
    }
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

  it('keeps the tick alive when one subscription throws, and removes only that row (R14)', async () => {
    const bad = await subscribe(studentAccountId, 'bad');
    const good = await subscribe(studentAccountId, 'good');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const calls: string[] = [];
    const send: PushSender = vi.fn(async (target, _payload, _urgency) => {
      if (target.endpoint === bad.endpoint) {
        throw new Error('ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY');
      }
      calls.push(target.endpoint);
      return { outcome: 'delivered' as const, status: 201 };
    });

    const result = await dispatchPushes(scoped([n.id]).db, send);

    expect(calls).toEqual([good.endpoint]);
    expect(await prisma.pushSubscription.findUnique({ where: { id: bad.id } })).toBeNull();
    expect(await prisma.pushSubscription.findUnique({ where: { id: good.id } })).not.toBeNull();
    expect(result.failed).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ notificationId: n.id, subscriptionId: bad.id }),
      expect.any(String),
    );
  });

  it('sends once when two ticks overlap', async () => {
    const sub = await subscribe(studentAccountId, 'overlap');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'waitlist_promoted' });
    const { send, calls } = recordingSender();
    // Both ticks share one racing+scoped client, so their `findMany`s hit
    // the same barrier: neither returns its candidate until the other has
    // also read it, which is what makes both ticks reach the claim with the
    // row still unclaimed — the exact race the CAS exists for.
    const s = scopedRacing([n.id]);
    await Promise.all([dispatchPushes(s.db, send), dispatchPushes(s.db, send)]);
    expect(calls.map((c) => c.endpoint)).toEqual([sub.endpoint]);
  });

  it('reaches a dual-role account for both profiles, each by its own prefs', async () => {
    const device = await subscribe(dualAccountId, 'dual');
    // Turn off only the teacher profile's group for this notification type,
    // so a push reaching the student side but not the teacher side can only
    // be explained by each profile reading its own preference columns.
    await prisma.teacher.update({ where: { id: dualTeacherId }, data: { pushAutoCancelled: false } });
    try {
      const asStudent = await notify({ recipientType: 'student', recipientId: dualStudentId, type: 'spot_available' });
      const asTeacher = await notify({ recipientType: 'teacher', recipientId: dualTeacherId, type: 'class_cancelled' });
      const { send, calls } = recordingSender();
      await dispatchPushes(scoped([asStudent.id, asTeacher.id]).db, send);
      expect(calls.map((c) => c.url)).toEqual([`/updates?n=${asStudent.id}`]);
      expect(new Set(calls.map((c) => c.endpoint))).toEqual(new Set([device.endpoint]));
    } finally {
      await prisma.teacher.update({ where: { id: dualTeacherId }, data: { pushAutoCancelled: true } });
    }
  });

  it('retires without sending for an unclaimed student and for an erased profile', async () => {
    const unclaimed = await notify({ recipientType: 'student', recipientId: unclaimedStudentId, type: 'walk_in_added' });
    const missing = await notify({ recipientType: 'student', recipientId: crypto.randomUUID(), type: 'spot_available' });
    await subscribe(erasedAccountId, 'erased');
    const erased = await notify({ recipientType: 'student', recipientId: erasedStudentId, type: 'spot_available' });
    const { send, calls } = recordingSender();
    await expect(dispatchPushes(scoped([unclaimed.id, missing.id, erased.id]).db, send)).resolves.toBeDefined();
    expect(calls).toHaveLength(0);
    for (const id of [unclaimed.id, missing.id, erased.id]) {
      expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).pushHandledAt).not.toBeNull();
    }
  });

  it('retires rows without sending when push is not configured', async () => {
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const result = await dispatchPushes(scoped([n.id]).db, null);
    expect(result.sent).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
  });
});
