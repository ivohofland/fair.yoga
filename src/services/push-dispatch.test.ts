import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, type NotificationType } from '@prisma/client';
import { dispatchPushes, PUSH_BATCH, PUSH_CLAIM_DEADLINE_MS, PUSH_STALE_AFTER_MS, PUSH_WORKERS, PushSendFault, type PushSender } from './push-dispatch';
import { DEFAULT_TIMEOUT_MS, PUSH_TTL_SECONDS, sendPush } from '@/lib/push/send';
import { generateVapidKeyPair } from '@/lib/push/test-support';
import { scopeSweep, type ScopedSweep } from '../../tests/scoped-sweep';
import { log } from '@/lib/log';
import type { VapidConfigProblem } from '@/lib/push/config';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();

const vapidKeys = { ...generateVapidKeyPair(), subject: 'mailto:ops@fair.yoga' };
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

/** A promise the test resolves explicitly — no timers, no sleeps. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A base client whose `pushSubscription.updateMany` throws `error` for the
 * `lastUsedAt` write on `subscriptionId` — calling `onReject` first, so a
 * test can wait for the throw without a sleep — and whose
 * `notification.updateMany` (the claim) for `notificationId` waits on
 * `gate` before running the real query, holding the claim loop at exactly
 * that await until the test releases it.
 */
function rejectingLastUsedThenGatedClaim(options: {
  subscriptionId: string;
  error: Error;
  onReject: () => void;
  notificationId: string;
  gate: Promise<void>;
}) {
  return prisma.$extends({
    query: {
      pushSubscription: {
        async updateMany({ args, query }) {
          const where = args.where as { id?: string } | undefined;
          if (where?.id === options.subscriptionId) {
            options.onReject();
            throw options.error;
          }
          return query(args);
        },
      },
      notification: {
        async updateMany({ args, query }) {
          const where = args.where as { id?: string } | undefined;
          if (where?.id === options.notificationId) {
            await options.gate;
          }
          return query(args);
        },
      },
    },
  });
}

/** A base client whose `notification.updateMany` (the claim) for `notificationId` throws `error`. */
function failingClaim(notificationId: string, error: Error) {
  return prisma.$extends({
    query: {
      notification: {
        async updateMany({ args, query }) {
          const where = args.where as { id?: string } | undefined;
          if (where?.id === notificationId) throw error;
          return query(args);
        },
      },
    },
  });
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
  // A summary asserted on is this test's own, not an earlier test's.
  beforeEach(() => {
    vi.mocked(log.info).mockClear();
  });

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
    await dispatchPushes(s.db, { send });
    expect(s.rowsRead('Notification')).toBeGreaterThan(0);
    expect(calls.map((c) => c.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
    expect(calls[0]).toMatchObject({ url: `/updates?n=${n.id}`, urgency: 'high' });
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(after.pushHandledAt).not.toBeNull();
    expect(after.isRead).toBe(false);
    expect(after.emailSent).toBe(false);
  });

  // Documents a Postgres guarantee rather than guarding code: another
  // connection never reads an uncommitted row, so no edit to dispatchPushes
  // can make this fail. It stays to show the sweep reads committed rows only.
  it('never pushes a notification whose transaction rolled back', async () => {
    await subscribe(studentAccountId, 'rb');
    let rolledBackId = '';
    await expect(prisma.$transaction(async (tx) => {
      const n = await tx.notification.create({ data: { recipientType: 'student', recipientId: studentId, type: 'spot_available', title: 'T', body: 'B' } });
      rolledBackId = n.id;
      const { send, calls } = recordingSender();
      await dispatchPushes(scoped([n.id]).db, { send }); // a concurrent tick while the writer is uncommitted
      expect(calls).toHaveLength(0);
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect(await prisma.notification.findUnique({ where: { id: rolledBackId } })).toBeNull();
  });

  it('retires a row past the stale cutoff without sending', async () => {
    await subscribe(studentAccountId, 'stale');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(Date.now() - PUSH_STALE_AFTER_MS - 1000) });
    const { send, calls } = recordingSender();
    await dispatchPushes(scoped([n.id]).db, { send });
    expect(calls).toHaveLength(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
  });

  it('honours an off group, and never pushes a student their own booking', async () => {
    await subscribe(studentAccountId, 'prefs');
    const optional = await notify({ recipientType: 'student', recipientId: studentId, type: 'announcement' });
    const own = await notify({ recipientType: 'student', recipientId: studentId, type: 'booking_confirmed' });
    const { send, calls } = recordingSender();
    await dispatchPushes(scoped([optional.id, own.id]).db, { send });
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
      await dispatchPushes(scoped([n.id]).db, { send });
      expect(calls[0]!.body).toBe('Open fair.yoga to see the details.');
    } finally {
      await prisma.student.update({ where: { id: studentId }, data: { pushPayments: false } });
    }
  });

  it('deletes a subscription the push service reports gone, and does not retry a failure', async () => {
    const gone = await subscribe(teacherAccountId, 'gone');
    const n = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });
    await dispatchPushes(scoped([n.id]).db, { send: recordingSender('gone').send });
    expect(await prisma.pushSubscription.findUnique({ where: { id: gone.id } })).toBeNull();

    const kept = await subscribe(teacherAccountId, 'fail');
    const m = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });
    const failing = recordingSender('failed');
    await dispatchPushes(scoped([m.id]).db, { send: failing.send });
    await dispatchPushes(scoped([m.id]).db, { send: failing.send });
    expect(failing.calls).toHaveLength(1);
    expect(await prisma.pushSubscription.findUnique({ where: { id: kept.id } })).not.toBeNull();
  });

  it('keeps the tick alive when one subscription has keys it cannot encrypt against, and removes only that row', async () => {
    const browser = crypto.createECDH('prime256v1');
    browser.generateKeys();
    const bad = await prisma.pushSubscription.create({
      data: {
        accountId: studentAccountId,
        endpoint: `https://fcm.googleapis.com/fcm/send/invalid-${crypto.randomUUID()}`,
        p256dh: Buffer.alloc(65, 4).toString('base64url'), // 65 bytes, off the curve
        auth: crypto.randomBytes(16).toString('base64url'),
      },
    });
    const good = await prisma.pushSubscription.create({
      data: {
        accountId: studentAccountId,
        endpoint: `https://fcm.googleapis.com/fcm/send/valid-${crypto.randomUUID()}`,
        p256dh: browser.getPublicKey().toString('base64url'),
        auth: crypto.randomBytes(16).toString('base64url'),
      },
    });
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));
    const send: PushSender = (target, payload, urgency) => sendPush(target, payload, vapidKeys, { urgency, fetchImpl });

    const result = await dispatchPushes(scoped([n.id]).db, { send });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([good.endpoint]);
    expect(result).toMatchObject({ sent: 1, invalid: 1, failed: 0 });
    expect(await prisma.pushSubscription.findUnique({ where: { id: bad.id } })).toBeNull();
    expect(await prisma.pushSubscription.findUnique({ where: { id: good.id } })).not.toBeNull();
  });

  it('keeps every subscription and rejects the tick when the sender throws a fault', async () => {
    const first = await subscribe(studentAccountId, 'fault-1');
    const second = await subscribe(studentAccountId, 'fault-2');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const fault = new Error('sender bug');
    const send: PushSender = vi.fn(async () => {
      throw fault;
    });

    const rejection: unknown = await dispatchPushes(scoped([n.id]).db, { send }).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(PushSendFault);
    const sendFault = rejection as PushSendFault;
    expect(sendFault.notificationId).toBe(n.id);
    expect([first.id, second.id]).toContain(sendFault.subscriptionId);
    expect(sendFault.cause).toBe(fault);

    expect(send).toHaveBeenCalledTimes(2);
    expect(await prisma.pushSubscription.findUnique({ where: { id: first.id } })).not.toBeNull();
    expect(await prisma.pushSubscription.findUnique({ where: { id: second.id } })).not.toBeNull();
    // One fault is rethrown; the other is logged with what it was sending.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: fault, notificationId: n.id, subscriptionId: expect.stringMatching(new RegExp(`^(${first.id}|${second.id})$`)) }),
      expect.any(String),
    );
  });

  it('warns with the cause and reason of a failed send, and logs the tick counts', async () => {
    const sub = await subscribe(teacherAccountId, 'failed-detail');
    const n = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });
    const send: PushSender = vi.fn(async () => ({ outcome: 'failed' as const, status: 403, reason: 'invalid JWT' }));

    const result = await dispatchPushes(scoped([n.id]).db, { send });

    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      { notificationId: n.id, subscriptionId: sub.id, status: 403, cause: undefined, reason: 'invalid JWT' },
      expect.any(String),
    );
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ failed: 1, claimed: 1 }), expect.any(String));
  });

  it('never leaves an early task rejection unhandled while the loop still awaits the next notification', async () => {
    const sub1 = await subscribe(studentAccountId, 'early-fail');
    const n1 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const sub2 = await subscribe(teacherAccountId, 'second');
    const n2 = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });

    const dbError = new Error('lastUsedAt write failed');
    const rejected = deferred<void>();
    const gate = deferred<void>();
    const hooked = rejectingLastUsedThenGatedClaim({
      subscriptionId: sub1.id,
      error: dbError,
      onReject: rejected.resolve,
      notificationId: n2.id,
      gate: gate.promise,
    });
    const s = scopeSweep(hooked as unknown as PrismaClient, { Notification: { id: { in: [n1.id, n2.id] } } });

    const calls: string[] = [];
    const send: PushSender = vi.fn(async (target) => {
      calls.push(target.endpoint);
      return { outcome: 'delivered' as const, status: 201 };
    });

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const pending = dispatchPushes(s.db, { send });

      // The first task's DB write rejects here, deliberately while the
      // claim loop is still parked on `gate` for n2 — a task that settles
      // before anything awaits it. `sendTo` resolves a `TaskFailure` rather
      // than rejecting, so nothing is left unhandled.
      await rejected.promise;
      // Flush a couple of microtask ticks so that `sendTo` has settled
      // (converted the rejection into a resolved value) before we let n2's
      // claim through — a flush, not a sleep.
      await Promise.resolve();
      await Promise.resolve();

      gate.resolve();

      const rejection: unknown = await pending.catch((err: unknown) => err);
      expect(rejection).toBeInstanceOf(PushSendFault);
      expect((rejection as PushSendFault).notificationId).toBe(n1.id);
      expect((rejection as PushSendFault).subscriptionId).toBe(sub1.id);
      expect((rejection as PushSendFault).cause).toBe(dbError);
      // n2's own send still went through despite n1's task failing —
      // one bad task does not stop the rest of the batch.
      expect(calls).toContain(sub2.endpoint);

      // One more flush: a late `unhandledRejection` fires asynchronously,
      // so give it a chance before asserting it never fired.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('holds every send for the tick before surfacing a claim failure, and lets none outlive it', async () => {
    const sub1 = await subscribe(studentAccountId, 'pending-send');
    const n1 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const n2 = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });

    const claimError = new Error('claim failed for n2');
    const hooked = failingClaim(n2.id, claimError);
    const s = scopeSweep(hooked as unknown as PrismaClient, { Notification: { id: { in: [n1.id, n2.id] } } });

    const sendGate = deferred<{ outcome: 'delivered' | 'gone' | 'failed'; status: number | null }>();
    const send: PushSender = vi.fn(async (target) => {
      if (target.endpoint === sub1.endpoint) return sendGate.promise;
      return { outcome: 'delivered' as const, status: 201 };
    });

    const pending = dispatchPushes(s.db, { send });
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    // n2's claim has already thrown by now (it needs no real I/O to do
    // so), but the tick cannot settle: `Promise.allSettled` over the
    // workers is still waiting on sub1's send, which only this test can
    // release.
    expect(settled).toBe(false);

    sendGate.resolve({ outcome: 'delivered', status: 201 });

    await expect(pending).rejects.toBe(claimError);
  });

  it('logs the counts of a tick that throws a send fault, and still throws the fault', async () => {
    const stale = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(Date.now() - PUSH_STALE_AFTER_MS - 60_000) });
    await subscribe(studentAccountId, 'fault-counts');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const send: PushSender = vi.fn(async () => {
      throw new Error('sender bug');
    });

    const rejection: unknown = await dispatchPushes(scoped([stale.id, n.id]).db, { send }).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(PushSendFault);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ retired: 1, claimed: 1, sent: 0, faulted: true }),
      'push dispatch tick',
    );
  });

  it('logs the counts of a tick whose worker crashes, and still throws the crash', async () => {
    await subscribe(studentAccountId, 'crash-counts');
    const stale = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(Date.now() - PUSH_STALE_AFTER_MS - 60_000) });
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const crashError = new Error('claim failed');
    const hooked = prisma.$extends({
      query: {
        notification: {
          async updateMany({ args, query }) {
            const where = args.where as { id?: string } | undefined;
            if (where?.id === n.id) throw crashError;
            return query(args);
          },
        },
      },
    });
    const s = scopeSweep(hooked as unknown as PrismaClient, { Notification: { id: { in: [stale.id, n.id] } } });
    const { send } = recordingSender();

    await expect(dispatchPushes(s.db, { send })).rejects.toBe(crashError);

    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ retired: 1, claimed: 0, faulted: true }),
      'push dispatch tick',
    );
  });

  it('logs the misconfiguration of a tick that throws before it retires anything', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', generateVapidKeyPair().publicKey);
    vi.stubEnv('VAPID_PRIVATE_KEY', undefined);
    vi.stubEnv('VAPID_SUBJECT', undefined);
    try {
      vi.resetModules();
      const { dispatchPushes: freshDispatch } = await import('./push-dispatch');
      const { log: freshLog } = await import('@/lib/log');
      const retireError = new Error('retire failed');
      const hooked = prisma.$extends({
        query: {
          notification: {
            async updateMany() {
              throw retireError;
            },
          },
        },
      });

      await expect(freshDispatch(hooked as unknown as PrismaClient)).rejects.toBe(retireError);

      expect(freshLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ retired: 0, misconfigured: 'partial', faulted: true }),
        'push dispatch tick',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not mark a clean tick\'s summary as faulted', async () => {
    const stale = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(Date.now() - PUSH_STALE_AFTER_MS - 60_000) });

    await dispatchPushes(scoped([stale.id]).db, { send: recordingSender().send });

    const summaries = vi.mocked(log.info).mock.calls.filter(([, msg]) => msg === 'push dispatch tick');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]![0]).toMatchObject({ retired: 1 });
    expect(summaries[0]![0]).not.toHaveProperty('faulted');
  });

  it('logs a send fault when a claim failure is the error that propagates', async () => {
    const sub1 = await subscribe(studentAccountId, 'fault-under-claim');
    const n1 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const n2 = await notify({ recipientType: 'teacher', recipientId: teacherId, type: 'class_cancelled' });
    const claimError = new Error('claim failed for n2');
    const s = scopeSweep(failingClaim(n2.id, claimError) as unknown as PrismaClient, { Notification: { id: { in: [n1.id, n2.id] } } });
    const fault = new Error('sender bug under a claim failure');
    const send: PushSender = vi.fn(async () => {
      throw fault;
    });

    await expect(dispatchPushes(s.db, { send })).rejects.toBe(claimError);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: fault, notificationId: n1.id, subscriptionId: sub1.id }),
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
    await Promise.all([dispatchPushes(s.db, { send }), dispatchPushes(s.db, { send })]);
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
      await dispatchPushes(scoped([asStudent.id, asTeacher.id]).db, { send });
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
    await expect(dispatchPushes(scoped([unclaimed.id, missing.id, erased.id]).db, { send })).resolves.toBeDefined();
    expect(calls).toHaveLength(0);
    for (const id of [unclaimed.id, missing.id, erased.id]) {
      expect((await prisma.notification.findUniqueOrThrow({ where: { id } })).pushHandledAt).not.toBeNull();
    }
  });

  describe('reporting a VAPID environment it cannot use', () => {
    // The report is once per process, so each case loads its own copy of
    // the module, and starts the mocked log's record empty.
    async function freshModule() {
      vi.resetModules();
      const { dispatchPushes: freshDispatch } = await import('./push-dispatch');
      const { log: freshLog } = await import('@/lib/log');
      vi.mocked(freshLog.error).mockClear();
      vi.mocked(freshLog.warn).mockClear();
      return { freshDispatch, freshLog };
    }

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('logs an error naming the reason, once, and no key, for a misconfiguration', async () => {
      const pair = generateVapidKeyPair();
      const other = generateVapidKeyPair();
      const privateKey = pair.privateKey;
      const publicKey = other.publicKey;
      vi.stubEnv('VAPID_PUBLIC_KEY', publicKey);
      vi.stubEnv('VAPID_PRIVATE_KEY', privateKey);
      vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      const { freshDispatch, freshLog } = await freshModule();

      await freshDispatch(scoped([]).db);
      await freshDispatch(scoped([]).db);

      expect(freshLog.error).toHaveBeenCalledTimes(1);
      expect(freshLog.error).toHaveBeenCalledWith({ reason: 'pair-mismatch' }, expect.any(String));
      expect(freshLog.warn).not.toHaveBeenCalled();
      const logged = JSON.stringify([vi.mocked(freshLog.error).mock.calls, vi.mocked(freshLog.warn).mock.calls]);
      expect(logged).not.toContain(privateKey);
      expect(logged).not.toContain(publicKey);
    });

    it('only warns when no VAPID variable is set', async () => {
      vi.stubEnv('VAPID_PUBLIC_KEY', undefined);
      vi.stubEnv('VAPID_PRIVATE_KEY', undefined);
      vi.stubEnv('VAPID_SUBJECT', undefined);
      const { freshDispatch, freshLog } = await freshModule();

      await freshDispatch(scoped([]).db);

      expect(freshLog.warn).toHaveBeenCalledTimes(1);
      expect(freshLog.error).not.toHaveBeenCalled();
    });

    // `invalid-scalar` needs a key the curve library rejects, which no plain
    // string builds; every other reason is a misconfiguration with a cheap recipe.
    const misconfigurations = {
      partial: () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', generateVapidKeyPair().publicKey);
        vi.stubEnv('VAPID_PRIVATE_KEY', undefined);
        vi.stubEnv('VAPID_SUBJECT', undefined);
      },
      'public-length': () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', Buffer.alloc(10, 1).toString('base64url'));
        vi.stubEnv('VAPID_PRIVATE_KEY', generateVapidKeyPair().privateKey);
        vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      },
      'private-length': () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', generateVapidKeyPair().publicKey);
        vi.stubEnv('VAPID_PRIVATE_KEY', Buffer.alloc(33, 1).toString('base64url'));
        vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      },
      subject: () => {
        const pair = generateVapidKeyPair();
        vi.stubEnv('VAPID_PUBLIC_KEY', pair.publicKey);
        vi.stubEnv('VAPID_PRIVATE_KEY', pair.privateKey);
        vi.stubEnv('VAPID_SUBJECT', 'ops@fair.yoga');
      },
      'pair-mismatch': () => {
        vi.stubEnv('VAPID_PUBLIC_KEY', generateVapidKeyPair().publicKey);
        vi.stubEnv('VAPID_PRIVATE_KEY', generateVapidKeyPair().privateKey);
        vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      },
    } satisfies Record<Exclude<VapidConfigProblem, 'unset' | 'invalid-scalar'>, () => void>;

    it.each(Object.entries(misconfigurations))('counts a row as unsendable for the %s misconfiguration', async (_reason, configure) => {
      const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      configure();
      const { freshDispatch } = await freshModule();

      const result = await freshDispatch(scoped([n.id]).db);

      expect(result).toMatchObject({ claimed: 1, unsendable: 1, sent: 0 });
    });

    it.each(Object.entries(misconfigurations))('reports the %s misconfiguration on a tick that claims nothing', async (reason, configure) => {
      configure();
      const { freshDispatch } = await freshModule();

      const result = await freshDispatch(scoped([]).db);

      expect(result).toMatchObject({ claimed: 0, unsendable: 0, misconfigured: reason });
    });

    it('reports no misconfiguration for an unset environment or an injected sender', async () => {
      vi.stubEnv('VAPID_PUBLIC_KEY', undefined);
      vi.stubEnv('VAPID_PRIVATE_KEY', undefined);
      vi.stubEnv('VAPID_SUBJECT', undefined);
      const unset = await freshModule();
      expect(await unset.freshDispatch(scoped([]).db)).toMatchObject({ misconfigured: null });

      misconfigurations.partial();
      const injected = await freshModule();
      const { send } = recordingSender();
      expect(await injected.freshDispatch(scoped([]).db, { send })).toMatchObject({ misconfigured: null });
    });

    it('counts the rows it claimed as unsendable for a misconfiguration, never for an unset environment', async () => {
      const n1 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      const n2 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      vi.stubEnv('VAPID_PUBLIC_KEY', generateVapidKeyPair().publicKey);
      vi.stubEnv('VAPID_PRIVATE_KEY', generateVapidKeyPair().privateKey);
      vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      const misconfigured = await freshModule();

      const bad = await misconfigured.freshDispatch(scoped([n1.id, n2.id]).db);

      expect(bad).toMatchObject({ claimed: 2, unsendable: 2, sent: 0 });
      expect(misconfigured.freshLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ unsendable: 2 }),
        expect.any(String),
      );

      const n3 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      vi.stubEnv('VAPID_PUBLIC_KEY', undefined);
      vi.stubEnv('VAPID_PRIVATE_KEY', undefined);
      vi.stubEnv('VAPID_SUBJECT', undefined);
      const unset = await freshModule();

      const none = await unset.freshDispatch(scoped([n3.id]).db);

      expect(none).toMatchObject({ claimed: 1, unsendable: 0 });
    });
  });

  describe('with VAPID_* set', () => {
    const vapidPrivate = generateVapidKeyPair();
    const otherPair = generateVapidKeyPair();

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    it.each([
      ['belongs to a different private key', otherPair.publicKey],
      ['is not a point on the curve', Buffer.alloc(65, 4).toString('base64url')],
    ])('retires the row without sending and keeps the subscription when the public key %s', async (_label, publicKey) => {
      vi.stubEnv('VAPID_PUBLIC_KEY', publicKey);
      vi.stubEnv('VAPID_PRIVATE_KEY', vapidPrivate.privateKey);
      vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
      // A browser key the encryption step accepts, so nothing about the
      // subscription itself can fail the send.
      const browser = crypto.createECDH('prime256v1');
      browser.generateKeys();
      const sub = await prisma.pushSubscription.create({
        data: {
          accountId: studentAccountId,
          endpoint: `https://push.invalid/misconfigured-${crypto.randomUUID()}`,
          p256dh: browser.getPublicKey().toString('base64url'),
          auth: crypto.randomBytes(16).toString('base64url'),
        },
      });
      const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });

      const result = await dispatchPushes(scoped([n.id]).db);

      expect(result).toMatchObject({ claimed: 1, sent: 0, gone: 0, failed: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
      expect(await prisma.pushSubscription.findUnique({ where: { id: sub.id } })).not.toBeNull();
    });

    it('sends through the production sender when the keys form a pair', async () => {
      const pair = generateVapidKeyPair();
      vi.stubEnv('VAPID_PUBLIC_KEY', pair.publicKey);
      vi.stubEnv('VAPID_PRIVATE_KEY', pair.privateKey);
      vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
      const browser = crypto.createECDH('prime256v1');
      browser.generateKeys();
      const sub = await prisma.pushSubscription.create({
        data: {
          accountId: studentAccountId,
          endpoint: `https://fcm.googleapis.com/fcm/send/production-${crypto.randomUUID()}`,
          p256dh: browser.getPublicKey().toString('base64url'),
          auth: crypto.randomBytes(16).toString('base64url'),
        },
      });
      const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });

      const result = await dispatchPushes(scoped([n.id]).db);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe(sub.endpoint);
      expect(new Headers(init?.headers).get('Urgency')).toBe('high');
      expect(result.sent).toBe(1);
      expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).lastUsedAt).not.toBeNull();
    });
  });

  it('retires rows without sending when push is not configured', async () => {
    // A usable environment, device and sender's network, so that only the
    // `null` sender stands between this row and a delivered push.
    const pair = generateVapidKeyPair();
    vi.stubEnv('VAPID_PUBLIC_KEY', pair.publicKey);
    vi.stubEnv('VAPID_PRIVATE_KEY', pair.privateKey);
    vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    try {
      const browser = crypto.createECDH('prime256v1');
      browser.generateKeys();
      await prisma.pushSubscription.create({
        data: {
          accountId: studentAccountId,
          endpoint: `https://fcm.googleapis.com/fcm/send/unconfigured-${crypto.randomUUID()}`,
          p256dh: browser.getPublicKey().toString('base64url'),
          auth: crypto.randomBytes(16).toString('base64url'),
        },
      });
      const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      const result = await dispatchPushes(scoped([n.id]).db, { send: null });
      expect(result).toMatchObject({ claimed: 1, sent: 0, unsendable: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
    } finally {
      vi.unstubAllEnvs();
      fetchSpy.mockRestore();
    }
  });

  it('holds the push TTL inside the stale cutoff, and the cutoff at fifteen minutes', () => {
    expect(PUSH_TTL_SECONDS * 1000).toBeLessThan(PUSH_STALE_AFTER_MS);
    expect(PUSH_STALE_AFTER_MS).toBe(15 * 60_000);
  });

  it('retires a row from sixteen minutes ago and sends one from fourteen', async () => {
    const sub = await subscribe(studentAccountId, 'freshness');
    const now = new Date();
    const stale = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(now.getTime() - 16 * 60_000) });
    const fresh = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(now.getTime() - 14 * 60_000) });
    const { send, calls } = recordingSender();

    const result = await dispatchPushes(scoped([stale.id, fresh.id]).db, { send, clock: () => now.getTime() });

    expect(result).toMatchObject({ retired: 1, claimed: 1, sent: 1 });
    expect(calls.map((c) => c.url)).toEqual([`/updates?n=${fresh.id}`]);
    expect(calls.map((c) => c.endpoint)).toEqual([sub.endpoint]);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: stale.id } })).pushHandledAt).not.toBeNull();
  });

  it('stamps the retire, the claim and the subscription with the clock it was given', async () => {
    const sub = await subscribe(studentAccountId, 'one-time-source');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    const stale = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available', createdAt: new Date(Date.now() - PUSH_STALE_AFTER_MS - 60_000) });
    const at = new Date(Date.now() + 60_000);
    const { send } = recordingSender();

    await dispatchPushes(scoped([n.id, stale.id]).db, { send, clock: () => at.getTime() });

    expect((await prisma.notification.findUniqueOrThrow({ where: { id: stale.id } })).pushHandledAt).toEqual(at);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).toEqual(at);
    expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { id: sub.id } })).lastUsedAt).toEqual(at);
  });

  it('claims the oldest candidates first when there are more than one batch', async () => {
    const now = new Date();
    const createdAt = (i: number) => new Date(now.getTime() - 10 * 60_000 + i * 1000);
    // Written newest first, so an order that follows insertion would claim
    // the newest row and leave the oldest.
    const ids: string[] = [];
    for (let i = PUSH_BATCH; i >= 0; i--) {
      const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'announcement', createdAt: createdAt(i) });
      ids.unshift(n.id);
    }

    const result = await dispatchPushes(scoped(ids).db, { send: null, clock: () => now.getTime() });

    expect(result.claimed).toBe(PUSH_BATCH);
    const rows = await prisma.notification.findMany({ where: { id: { in: ids } }, select: { id: true, pushHandledAt: true } });
    const unhandled = rows.filter((r) => r.pushHandledAt === null).map((r) => r.id);
    expect(unhandled).toEqual([ids[PUSH_BATCH]]);
  });

  describe('the claim deadline', () => {
    /** One notification per candidate, all for the one-device student account. */
    async function seedBatch(total: number): Promise<string[]> {
      await subscribe(studentAccountId, 'deadline');
      const now = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < total; i++) {
        const n = await notify({
          recipientType: 'student',
          recipientId: studentId,
          type: 'spot_available',
          createdAt: new Date(now - 60_000 + i * 1000),
        });
        ids.push(n.id);
      }
      return ids;
    }

    it('stops claiming once the deadline passes, leaving the rest unclaimed and every claimed row with an outcome', async () => {
      const ids = await seedBatch(20);
      // Each send "takes" one send timeout on a clock the test owns, the way
      // a push service that never answers does.
      let fakeNow = Date.now();
      const send: PushSender = vi.fn(async () => {
        fakeNow += DEFAULT_TIMEOUT_MS;
        return { outcome: 'failed' as const, status: null };
      });

      const result = await dispatchPushes(scoped(ids).db, { send, clock: () => fakeNow });

      // Every worker claims once before any send can move the clock, and a
      // worker finishing after the clock has run one deadline's worth of
      // sends claims no more.
      expect(result.claimed).toBeGreaterThanOrEqual(PUSH_WORKERS);
      // The upper bound is the parallel-clock ceiling; this test's sequential
      // fake clock reaches a lower maximum, so it catches a missing deadline
      // but not a slightly lax one. The exact-boundary tests are the pin.
      expect(result.claimed).toBeLessThanOrEqual(PUSH_WORKERS * Math.ceil(PUSH_CLAIM_DEADLINE_MS / DEFAULT_TIMEOUT_MS));
      expect(result.failed).toBe(result.claimed);
      const rows = await prisma.notification.findMany({ where: { id: { in: ids } }, select: { pushHandledAt: true } });
      expect(rows.filter((r) => r.pushHandledAt !== null)).toHaveLength(result.claimed);
    });

    it('serves the deferred rows on the next tick', async () => {
      const ids = await seedBatch(12);
      let fakeNow = Date.now();
      const slow: PushSender = vi.fn(async () => {
        fakeNow += DEFAULT_TIMEOUT_MS;
        return { outcome: 'failed' as const, status: null };
      });
      const first = await dispatchPushes(scoped(ids).db, { send: slow, clock: () => fakeNow });
      expect(first.claimed).toBeLessThan(12);

      const { send, calls } = recordingSender();
      const second = await dispatchPushes(scoped(ids).db, { send });

      expect(second.claimed).toBe(12 - first.claimed);
      expect(calls).toHaveLength(12 - first.claimed);
    });

    it('claims nothing when the clock is exactly at the deadline', async () => {
      const ids = await seedBatch(3);
      let reads = 0;
      const start = Date.now();
      const clock = () => (reads++ === 0 ? start : start + PUSH_CLAIM_DEADLINE_MS);
      const { send } = recordingSender();

      const result = await dispatchPushes(scoped(ids).db, { send, clock });

      expect(result.claimed).toBe(0);
    });

    it('claims while the clock is one millisecond short of the deadline', async () => {
      const ids = await seedBatch(3);
      let reads = 0;
      const start = Date.now();
      const clock = () => (reads++ === 0 ? start : start + PUSH_CLAIM_DEADLINE_MS - 1);
      const { send } = recordingSender();

      const result = await dispatchPushes(scoped(ids).db, { send, clock });

      expect(result.claimed).toBe(3);
    });
  });

  it('works four notifications at once and no more', async () => {
    await subscribe(studentAccountId, 'workers');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' })).id);
    }
    // Four sends park here. A fifth worker would have claimed and started the
    // fifth notification by the time the fourth is in flight, so the count is
    // read once the claim queries have had a moment to land.
    const four = deferred<void>();
    const release = deferred<void>();
    let inFlight = 0;
    let peak = 0;
    const send: PushSender = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (inFlight === 4) four.resolve();
      await release.promise;
      inFlight -= 1;
      return { outcome: 'delivered' as const, status: 201 };
    });

    const pending = dispatchPushes(scoped(ids).db, { send });
    await four.promise;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(send).toHaveBeenCalledTimes(4);
    release.resolve();
    const result = await pending;

    expect(result.sent).toBe(5);
    expect(peak).toBe(4);
  });

  it('keeps the other workers claiming after one worker crashes, and logs the crashes after the first', async () => {
    await subscribe(studentAccountId, 'survivors');
    const ids: string[] = [];
    const base = Date.now() - 60_000;
    for (let i = 0; i < 6; i++) {
      const n = await notify({
        recipientType: 'student',
        recipientId: studentId,
        type: 'spot_available',
        createdAt: new Date(base + i * 1000),
      });
      ids.push(n.id);
    }
    const crashError = new Error('claim failed');
    const crashing = new Set([ids[1]!, ids[2]!]);
    const hooked = prisma.$extends({
      query: {
        notification: {
          async updateMany({ args, query }) {
            const where = args.where as { id?: string } | undefined;
            if (where?.id !== undefined && crashing.has(where.id)) throw crashError;
            return query(args);
          },
        },
      },
    });
    const s = scopeSweep(hooked as unknown as PrismaClient, { Notification: { id: { in: ids } } });
    const { send } = recordingSender();

    await expect(dispatchPushes(s.db, { send })).rejects.toBe(crashError);

    // Two of the six never reached a send; the four others were all sent,
    // including those a crashed worker would otherwise have left to its turn.
    expect(send).toHaveBeenCalledTimes(4);
    expect(log.error).toHaveBeenCalledWith({ err: crashError }, 'push dispatch worker failed');
  });

  it('sends to a recipient\'s devices in parallel, so one slow device does not hold the others', async () => {
    await subscribe(studentAccountId, 'par-1');
    await subscribe(studentAccountId, 'par-2');
    await subscribe(studentAccountId, 'par-3');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    // Each send waits for all three to be in flight; a sender that ran them
    // one after another would wait on the first forever.
    const allArrived = deferred<void>();
    let inFlight = 0;
    const send: PushSender = vi.fn(async () => {
      inFlight += 1;
      if (inFlight === 3) allArrived.resolve();
      await allArrived.promise;
      return { outcome: 'delivered' as const, status: 201 };
    });

    const result = await dispatchPushes(scoped([n.id]).db, { send });

    expect(result.sent).toBe(3);
  });

  it('retires without sending for an erased teacher profile', async () => {
    const account = await prisma.account.create({ data: { email: `push-erased-teacher-${uniqueSuffix}@test.local` } });
    accountIds.push(account.id);
    const teacher = await prisma.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Deleted',
        lastName: 'Teacher',
        email: `push-erased-teacher-deleted-${uniqueSuffix}@test.local`,
        bio: 'Push dispatch erased teacher',
        pageSlug: `push-erased-teacher-${uniqueSuffix}`,
        deletedAt: new Date(),
      },
    });
    teacherIds.push(teacher.id);
    await subscribe(account.id, 'erased-teacher');
    const n = await notify({ recipientType: 'teacher', recipientId: teacher.id, type: 'class_cancelled' });
    const { send, calls } = recordingSender();

    const result = await dispatchPushes(scoped([n.id]).db, { send });

    expect(result.claimed).toBe(1);
    expect(calls).toHaveLength(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).pushHandledAt).not.toBeNull();
  });
});
