import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, onTestFinished } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient, Prisma, type PrismaClient, type ProcessorPaymentStatus, type ProcessorRefundStatus } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import { hhmmToTime } from '@/lib/time-of-day';
import { MollieUnavailable, type MollieClient, type MolliePaymentView, type RefundAnswer } from '@/lib/mollie/client';
import { MOLLIE_SCOPES } from '@/lib/processor-liveness';
import { sealToken } from '@/lib/processor-token-cipher';
import { uniqueSuffix } from '../../tests/helpers';
import { createClassFixture } from '../../tests/class-fixtures';
import type { MollieDeps } from './mollie-deps';
import { markPaymentNotCharged } from './payments';
import { syncAttempt } from './processor-attempts';
import { refundAttempt, type RefundResult } from './processor-refunds';
import { ADOPT_AFTER_MS } from './refund-adoption';

const prisma = createPrismaClient();
const key = randomBytes(32);
const MINUTE = 60_000;

type Fake = { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const fake = { refresh: vi.fn(), createRefund: vi.fn(), getPayment: vi.fn() } as unknown as Fake;
const deps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'client', clientSecret: 'secret', tokenKey: key, testmode: true, appUrl: 'https://fair.yoga' },
};

const teacherIds: string[] = [];
const accountIds: string[] = [];
const studentIds: string[] = [];
const roomIds: string[] = [];

let teacherId = '';
let teacherRoomId = '';
let studentId = '';
let connectionId = '';
let seededClasses = 0;

const trId = () => `tr_${uniqueSuffix().replace(/-/g, '')}`;
const reId = () => `re_${uniqueSuffix().replace(/-/g, '')}`;

async function seedConnection() {
  await prisma.processorPayment.deleteMany({ where: { connection: { teacherId } } });
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
  const row = await prisma.processorConnection.create({
    data: {
      teacherId,
      processor: 'mollie',
      organizationId: 'org_refund',
      profileId: 'pfl_refund',
      accessToken: new Uint8Array(sealToken('access_plain', key)),
      refreshToken: new Uint8Array(sealToken('refresh_plain', key)),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...MOLLIE_SCOPES],
      testmode: true,
    },
  });
  connectionId = row.id;
}

/** A completed euro class with one registration, its payment of 10.00, and one Mollie attempt on it. */
async function attemptOn(
  paymentStatus: 'pending' | 'paid' | 'not_charged',
  attempt: Partial<{ status: ProcessorPaymentStatus; settledPayment: boolean; chargedBackAt: Date | null; testmode: boolean; connectionId: string | null }> = {},
) {
  const s = uniqueSuffix();
  const cls = await createClassFixture(prisma, {
    teacherId, teacherRoomId, classType: `Refund ${s}`, date: new Date(Date.UTC(2026, 4, 1 + seededClasses++)),
    startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: 20, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 10,
    status: 'completed', effectiveTeacherRate: 10, totalStudents: 1, totalRevenue: 30, vatTotal: 0, currency: 'EUR',
  });
  const registration = await prisma.registration.create({ data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 } });
  const payment = await prisma.payment.create({
    data: {
      registrationId: registration.id, amount: 10, status: paymentStatus,
      method: paymentStatus === 'paid' ? 'mollie' : null,
      paidAt: paymentStatus === 'paid' ? new Date() : null,
      notChargedAt: paymentStatus === 'not_charged' ? new Date() : null,
    },
  });
  const row = await prisma.processorPayment.create({
    data: {
      paymentId: payment.id, connectionId, processorPaymentId: trId(), profileId: 'pfl_refund', testmode: true, method: 'ideal',
      status: 'paid', paidAt: new Date(), amount: new Prisma.Decimal('10.00'), currency: 'EUR',
      checkoutUrl: null, expiresAt: new Date(Date.now() + 10 * MINUTE),
      ...attempt,
    },
  });
  return { paymentId: payment.id, attempt: row, classId: cls.id };
}

/** A payment Mollie settled through one attempt. */
const settledAttempt = () => attemptOn('paid', { settledPayment: true });
/** A payment paid by hand that a Mollie attempt paid a second time. */
const duplicateAttempt = () => attemptOn('paid', { settledPayment: false });

function created(status: ProcessorRefundStatus, id = reId()): RefundAnswer {
  return { kind: 'created', refund: { id, status, amount: { value: '10.00', currency: 'EUR' } } };
}

function view(processorPaymentId: string, refunds: MolliePaymentView['refunds']): MolliePaymentView {
  return {
    id: processorPaymentId, status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' },
    checkoutUrl: null, expiresAt: null, paidAt: new Date().toISOString(), amountChargedBack: null, refunds,
  };
}

/** Mollie reports the attempt's one stored refund as `status`. */
async function mollieReports(attempt: { id: string; processorPaymentId: string }, status: ProcessorRefundStatus) {
  const row = await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: attempt.id, processorRefundId: { not: null } }, orderBy: { requestedAt: 'desc' } });
  fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, [{ id: row.processorRefundId!, status, amount: { value: '10.00', currency: 'EUR' } }]));
}

function notes(type: 'payment_refunded' | 'refund_failed', classId: string) {
  return prisma.notification.findMany({ where: { type, relatedClassId: classId } });
}

function refusalCode(result: RefundResult): string | null {
  return result.kind === 'refused' ? result.refusal.code : null;
}

beforeAll(async () => {
  const s = uniqueSuffix();
  const email = `refund-teacher-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Ref', lastName: 'Und', email, bio: '', pageSlug: `refund-${s}`, currency: 'EUR', account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherId = t.id;
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  const room = await prisma.room.create({
    data: { venueName: 'Refund Studio', address: `${s} St`, city: 'Amsterdam', postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacherId },
  });
  roomIds.push(room.id);
  teacherRoomId = (await prisma.teacherRoom.create({ data: { teacherId, roomId: room.id, capacityOverride: 15, rentalRate: 25 } })).id;
  const semail = `refund-student-${s}@test.local`;
  const student = await prisma.student.create({
    data: { firstName: 'Stu', lastName: 'Dent', email: semail, claimedAt: new Date(), account: { create: { email: semail } } },
    select: { id: true, accountId: true },
  });
  studentId = student.id;
  studentIds.push(student.id);
  accountIds.push(student.accountId as string);
});

beforeEach(async () => {
  for (const fn of Object.values(fake)) fn.mockReset();
  vi.mocked(logDegraded).mockClear();
  await seedConnection();
  fake.createRefund.mockImplementation(async () => created('queued'));
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: { in: [...teacherIds, ...studentIds] } } });
  await prisma.processorPayment.deleteMany({ where: { payment: { registration: { studentId: { in: studentIds } } } } });
  await prisma.processorConnection.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
  await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('refundAttempt', () => {
  it('records a waive on the settling attempt and applies it only once Mollie reports the refund refunded', async () => {
    const c = await settledAttempt();
    const mollieId = reId();
    fake.createRefund.mockResolvedValue(created('queued', mollieId));

    const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

    expect(result).toEqual({ kind: 'requested', refundStatus: 'queued', outcomeApplied: false });
    expect(fake.createRefund).toHaveBeenCalledWith('access_plain', c.attempt.processorPaymentId, {
      amount: { value: '10.00', currency: 'EUR' }, testmode: true,
    });
    expect(await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } })).toMatchObject({
      outcome: 'waived', processorRefundId: mollieId, status: 'queued',
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
    expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(true);
    expect(await notes('payment_refunded', c.classId)).toHaveLength(0);

    await prisma.payment.update({ where: { id: c.paymentId }, data: { studentReportedAt: new Date() } });
    await mollieReports(c.attempt, 'refunded');
    await syncAttempt(prisma, deps, c.attempt.processorPaymentId);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
    expect(payment.status).toBe('not_charged');
    expect(payment.notChargedAt).not.toBeNull();
    expect(payment.studentReportedAt).toBeNull();
    expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(false);
    expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
  });

  it('records an ask-again on the settling attempt and reopens the payment once the refund is refunded', async () => {
    const c = await settledAttempt();

    const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'ask_again' });

    expect(result).toEqual({ kind: 'requested', refundStatus: 'queued', outcomeApplied: false });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
    expect((await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } })).outcome).toBe('reopened');

    await mollieReports(c.attempt, 'refunded');
    await syncAttempt(prisma, deps, c.attempt.processorPaymentId);

    expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).toMatchObject({ status: 'pending', method: null, paidAt: null });
    expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(false);
  });

  describe('when Mollie answers the create already refunded', () => {
    it('applies a waive in the call, once', async () => {
      const c = await settledAttempt();
      fake.createRefund.mockResolvedValue(created('refunded'));

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      expect(result).toEqual({ kind: 'requested', refundStatus: 'refunded', outcomeApplied: true });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('not_charged');
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(false);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);

      await mollieReports(c.attempt, 'refunded');
      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('not_charged');
    });

    it('applies an ask-again in the call, taking the link lock before the payment', async () => {
      const c = await settledAttempt();
      fake.createRefund.mockResolvedValue(created('refunded'));
      const transactions: string[][] = [];
      const recording = recordingTransactions(transactions);

      const result = await refundAttempt(recording, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'ask_again' });

      expect(result).toEqual({ kind: 'requested', refundStatus: 'refunded', outcomeApplied: true });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('pending');
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(false);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
      // The intent's transaction locks the payment alone; the completing one takes the link first.
      expect(transactions[0]!.filter((s) => s.includes('FOR UPDATE')).every((s) => s.includes('"Payment"'))).toBe(true);
      const completing = transactions[transactions.length - 1]!;
      const link = completing.findIndex((s) => s.includes('"TeacherStudent"'));
      const paymentLock = completing.findIndex((s) => s.includes('"Payment"') && s.includes('FOR UPDATE'));
      expect(link).toBeGreaterThanOrEqual(0);
      expect(link).toBeLessThan(paymentLock);
    });
  });

  it('refunds a duplicate attempt without a choice, leaving the payment alone', async () => {
    const c = await duplicateAttempt();
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });

    const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null });

    expect(result).toEqual({ kind: 'requested', refundStatus: 'queued', outcomeApplied: false });
    expect(fake.createRefund).toHaveBeenCalledTimes(1);
    expect((await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } })).outcome).toBeNull();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).updatedAt).toEqual(before.updatedAt);
  });

  it('refunds in the mode the attempt was made in, not the connection’s current one', async () => {
    const c = await settledAttempt();
    await prisma.processorConnection.update({ where: { id: connectionId }, data: { testmode: false } });

    await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

    expect(fake.createRefund).toHaveBeenCalledWith('access_plain', c.attempt.processorPaymentId, expect.objectContaining({ testmode: true }));
  });

  describe('requires a choice exactly when the attempt settled the payment', () => {
    it('answers invalid for the settling attempt without one', async () => {
      const c = await settledAttempt();
      expect((await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null })).kind).toBe('invalid');
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });

    it('answers invalid for a duplicate with one', async () => {
      const c = await duplicateAttempt();
      expect((await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).kind).toBe('invalid');
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });
  });

  describe('refuses', () => {
    it.each(['open', 'failed'] as const)('an attempt still %s with REFUND_NOT_ALLOWED', async (status) => {
      const c = await attemptOn('pending', { status });
      expect(refusalCode(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null }))).toBe('REFUND_NOT_ALLOWED');
      expect(fake.createRefund).not.toHaveBeenCalled();
    });

    it('a charged-back attempt with REFUND_NOT_ALLOWED, without calling Mollie', async () => {
      const c = await attemptOn('paid', { settledPayment: false, chargedBackAt: new Date() });
      expect(refusalCode(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null }))).toBe('REFUND_NOT_ALLOWED');
      expect(fake.createRefund).not.toHaveBeenCalled();
    });

    it('an attempt of another payment with NOT_FOUND', async () => {
      const c = await settledAttempt();
      const other = await duplicateAttempt();
      expect(refusalCode(await refundAttempt(prisma, deps, { paymentId: other.paymentId, attemptId: c.attempt.id, choice: 'waive' }))).toBe('NOT_FOUND');
      expect(fake.createRefund).not.toHaveBeenCalled();
    });

    it('an attempt whose connection is gone with PROCESSOR_NOT_CONNECTED', async () => {
      const c = await attemptOn('paid', { settledPayment: true, connectionId: null });
      expect(refusalCode(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(fake.createRefund).not.toHaveBeenCalled();
    });

    it('a second of two concurrent requests with REFUND_ALREADY_REQUESTED, calling Mollie once', async () => {
      const c = await settledAttempt();
      const input = { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' } as const;

      const results = await Promise.all([refundAttempt(prisma, deps, input), refundAttempt(prisma, deps, input)]);

      expect(fake.createRefund).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.kind).sort()).toEqual(['refused', 'requested']);
      expect(results.map(refusalCode)).toContain('REFUND_ALREADY_REQUESTED');
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(1);
    });
  });

  describe('when Mollie does not take the refund', () => {
    it('refused for the balance answers REFUND_REFUSED naming the balance and deletes only its own row', async () => {
      const c = await settledAttempt();
      const earlier = await prisma.processorRefund.create({
        data: { attemptId: c.attempt.id, processorRefundId: reId(), amount: new Prisma.Decimal('10.00'), status: 'failed', outcome: 'waived' },
      });
      fake.createRefund.mockResolvedValue({ kind: 'refused', detail: 'Insufficient balance', field: null });

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
      expect(result.refusal.code).toBe('REFUND_REFUSED');
      expect(result.refusal.message).toMatch(/Mollie balance/);
      expect((await prisma.processorRefund.findMany({ where: { attemptId: c.attempt.id }, select: { id: true } })).map((r) => r.id)).toEqual([earlier.id]);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).toMatchObject({ status: 'paid' });
    });

    it('refused for another reason answers REFUND_REFUSED with Mollie’s detail', async () => {
      const c = await settledAttempt();
      fake.createRefund.mockResolvedValue({ kind: 'refused', detail: 'The payment cannot be refunded', field: null });

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
      expect(result.refusal.code).toBe('REFUND_REFUSED');
      expect(result.refusal.message).toContain('The payment cannot be refunded');
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });

    it('answers unavailable and deletes the row when Mollie is not configured', async () => {
      const c = await settledAttempt();
      expect(await refundAttempt(prisma, null, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unavailable' });
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });

    it('refuses PROCESSOR_NOT_CONNECTED, recording no row, when the connection was revoked', async () => {
      const c = await settledAttempt();
      const now = new Date();
      await prisma.processorConnection.update({
        where: { id: connectionId },
        data: { disconnectedAt: now, revokeAfter: now, revokedAt: now, accessToken: null, refreshToken: null, accessTokenExpiresAt: null },
      });

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
      expect(result.refusal).toMatchObject({
        code: 'PROCESSOR_NOT_CONNECTED',
        message: 'Mollie is no longer connected, so this can’t be refunded here. Mark it unpaid or refund it in Mollie.',
      });
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });

    it('refuses PROCESSOR_NOT_CONNECTED and deletes the row when Mollie refuses the refresh token', async () => {
      const c = await settledAttempt();
      await prisma.processorConnection.update({ where: { id: connectionId }, data: { accessTokenExpiresAt: new Date(Date.now() + 1_000) } });
      fake.refresh.mockResolvedValue({ kind: 'invalid_grant' });

      expect(refusalCode(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });
  });

  it('after a refund failed leaves the payment paid, tells the teacher, and takes a new refund that still needs a choice', async () => {
    const c = await settledAttempt();
    expect((await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'ask_again' })).kind).toBe('requested');

    await mollieReports(c.attempt, 'failed');
    await syncAttempt(prisma, deps, c.attempt.processorPaymentId);

    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
    expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(true);
    expect(await notes('refund_failed', c.classId)).toHaveLength(1);

    expect((await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null })).kind).toBe('invalid');
    expect((await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).kind).toBe('requested');
    expect(fake.createRefund).toHaveBeenCalledTimes(2);
  });
});

describe('refundAttempt: an intent is resolved, never stranded', () => {
  const amount = { value: '10.00', currency: 'EUR' };

  function listed(attempt: { processorPaymentId: string }, refunds: MolliePaymentView['refunds']) {
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, refunds));
  }

  /** `prisma` whose `processorConnection` reads throw, so `getAccessToken` does. */
  function tokenThrows(): PrismaClient {
    return new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'processorConnection') {
          return { findUnique: () => Promise.reject(new Error('connection read failed')) };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** `prisma` whose second `$transaction` (the one storing Mollie's answer) throws. */
  function answerStoreThrows(): PrismaClient {
    let calls = 0;
    return new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === '$transaction') {
          return (fn: TransactionFn) => {
            calls += 1;
            if (calls === 2) return Promise.reject(new Error('lock timeout'));
            return target.$transaction(fn);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
  }

  async function awaitingRow(attemptId: string, ageMs: number, outcome: 'waived' | 'reopened' | null = 'waived') {
    return prisma.processorRefund.create({
      data: {
        attemptId, processorRefundId: null, amount: new Prisma.Decimal('10.00'), status: 'queued', outcome,
        requestedAt: new Date(Date.now() - ageMs),
      },
    });
  }

  describe('withdraws when nothing can exist at Mollie', () => {
    it('a throw from getAccessToken withdraws the intent and rethrows', async () => {
      const c = await settledAttempt();
      await expect(refundAttempt(tokenThrows(), deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).rejects.toThrow('connection read failed');
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });
  });

  describe('after an ambiguous failure of the create, asks Mollie once', () => {
    it('adopts the refund Mollie lists, and applies its outcome', async () => {
      const error = vi.spyOn(log, 'error');
      onTestFinished(() => error.mockRestore());
      const c = await settledAttempt();
      const held = await prisma.processorRefund.create({
        data: { attemptId: c.attempt.id, processorRefundId: reId(), amount: new Prisma.Decimal('10.00'), status: 'failed', outcome: 'waived' },
      });
      const mollieId = reId();
      fake.createRefund.mockRejectedValue(new MollieUnavailable('timed out', null));
      listed(c.attempt, [
        { id: held.processorRefundId!, status: 'failed', amount },
        { id: reId(), status: 'refunded', amount: { value: '4.00', currency: 'EUR' } },
        { id: mollieId, status: 'refunded', amount },
      ]);

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      expect(result).toEqual({ kind: 'requested', refundStatus: 'refunded', outcomeApplied: true });
      expect(fake.getPayment).toHaveBeenCalledWith('access_plain', c.attempt.processorPaymentId, { testmode: true });
      expect(await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id, id: { not: held.id } } })).toMatchObject({
        processorRefundId: mollieId, status: 'refunded', outcome: 'waived',
      });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('not_charged');
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
      expect(logDegraded).toHaveBeenCalledWith('MOLLIE_UNAVAILABLE', expect.objectContaining({ operation: 'createRefund' }), expect.any(String), expect.any(MollieUnavailable));
      expect(error).not.toHaveBeenCalled();
    });

    it('prefers a live refund to a failed one of the same amount', async () => {
      const c = await settledAttempt();
      const real = reId();
      fake.createRefund.mockRejectedValue(new MollieUnavailable('timed out', null));
      listed(c.attempt, [
        { id: reId(), status: 'failed', amount },
        { id: real, status: 'queued', amount },
      ]);

      expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({
        kind: 'requested', refundStatus: 'queued', outcomeApplied: false,
      });
      expect(await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } })).toMatchObject({ processorRefundId: real, status: 'queued' });
    });

    it('withdraws when Mollie lists none, and answers unavailable', async () => {
      const c = await settledAttempt();
      fake.createRefund.mockRejectedValue(new MollieUnavailable('bad gateway', 502));
      listed(c.attempt, [{ id: reId(), status: 'queued', amount: { value: '9.99', currency: 'EUR' } }]);

      expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unavailable' });

      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
    });

    it('treats a throw that is not Mollie’s the same way', async () => {
      const c = await settledAttempt();
      fake.createRefund.mockRejectedValue(new TypeError('socket hang up'));
      listed(c.attempt, []);

      expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unavailable' });
      expect(fake.getPayment).toHaveBeenCalledTimes(1);
      expect(await prisma.processorRefund.count({ where: { attemptId: c.attempt.id } })).toBe(0);
    });

    it('keeps the intent and logs it when Mollie cannot say either', async () => {
      const error = vi.spyOn(log, 'error');
      onTestFinished(() => error.mockRestore());
      const c = await settledAttempt();
      fake.createRefund.mockRejectedValue(new MollieUnavailable('timed out', null));
      fake.getPayment.mockRejectedValue(new MollieUnavailable('timed out', null));

      expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unavailable' });

      const kept = await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } });
      expect(kept).toMatchObject({ processorRefundId: null, status: 'queued' });
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ attemptId: c.attempt.id, refundId: kept.id }), expect.any(String));
    });
  });

  it('logs Mollie’s refund id and rethrows when storing its answer fails, keeping the intent', async () => {
    const error = vi.spyOn(log, 'error');
    onTestFinished(() => error.mockRestore());
    const c = await settledAttempt();
    const mollieId = reId();
    fake.createRefund.mockResolvedValue(created('queued', mollieId));

    await expect(refundAttempt(answerStoreThrows(), deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).rejects.toThrow('lock timeout');

    const kept = await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } });
    expect(kept.processorRefundId).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: c.attempt.id, refundId: kept.id, mollieRefundId: mollieId, refundStatus: 'queued' }),
      expect.any(String),
    );
  });

  describe('with an earlier intent still awaiting its Mollie id', () => {
    it('refuses REFUND_ALREADY_REQUESTED while it is young, asking Mollie nothing', async () => {
      const c = await settledAttempt();
      await awaitingRow(c.attempt.id, 10_000);

      expect(refusalCode(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' }))).toBe('REFUND_ALREADY_REQUESTED');
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(fake.getPayment).not.toHaveBeenCalled();
    });

    it('adopts a stale one Mollie lists and answers as if this call had made it', async () => {
      const c = await settledAttempt();
      const stale = await awaitingRow(c.attempt.id, ADOPT_AFTER_MS + 60_000);
      const mollieId = reId();
      listed(c.attempt, [{ id: mollieId, status: 'pending', amount }]);

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      expect(result).toEqual({ kind: 'requested', refundStatus: 'pending', outcomeApplied: false });
      expect(fake.createRefund).not.toHaveBeenCalled();
      expect(await prisma.processorRefund.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ processorRefundId: mollieId, status: 'pending' });
    });

    it('answers unchanged when the stale one Mollie lists is already refunded, applying its outcome', async () => {
      const c = await settledAttempt();
      await awaitingRow(c.attempt.id, ADOPT_AFTER_MS + 60_000, 'reopened');
      listed(c.attempt, [{ id: reId(), status: 'refunded', amount }]);

      expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unchanged' });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('pending');
      expect(fake.createRefund).not.toHaveBeenCalled();
    });

    it('withdraws a stale one Mollie does not list, then refunds as asked', async () => {
      const c = await settledAttempt();
      const stale = await awaitingRow(c.attempt.id, ADOPT_AFTER_MS + 60_000, 'reopened');
      listed(c.attempt, []);
      const mollieId = reId();
      fake.createRefund.mockResolvedValue(created('queued', mollieId));

      const result = await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' });

      expect(result).toEqual({ kind: 'requested', refundStatus: 'queued', outcomeApplied: false });
      expect(await prisma.processorRefund.count({ where: { id: stale.id } })).toBe(0);
      expect(await prisma.processorRefund.findFirstOrThrow({ where: { attemptId: c.attempt.id } })).toMatchObject({ processorRefundId: mollieId, outcome: 'waived' });
      expect(fake.createRefund).toHaveBeenCalledTimes(1);
    });

    it('answers unavailable, keeping a stale one, when getting a token throws', async () => {
      const c = await settledAttempt();
      const stale = await awaitingRow(c.attempt.id, ADOPT_AFTER_MS + 60_000);

      expect(await refundAttempt(tokenThrows(), deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unavailable' });
      expect(await prisma.processorRefund.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ processorRefundId: null });
      expect(fake.getPayment).not.toHaveBeenCalled();
    });

    it('answers unavailable, keeping a stale one, when Mollie cannot say', async () => {
      const c = await settledAttempt();
      const stale = await awaitingRow(c.attempt.id, ADOPT_AFTER_MS + 60_000);
      fake.getPayment.mockRejectedValue(new MollieUnavailable('timed out', null));

      expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unavailable' });
      expect(await prisma.processorRefund.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ processorRefundId: null });
      expect(fake.createRefund).not.toHaveBeenCalled();
    });
  });
});

describe('refundAttempt: other answers', () => {
  it('answers unchanged for an attempt already refunded, whatever the choice, asking Mollie nothing', async () => {
    const c = await attemptOn('not_charged', { settledPayment: false });
    await prisma.processorRefund.create({
      data: { attemptId: c.attempt.id, processorRefundId: reId(), amount: new Prisma.Decimal('10.00'), status: 'refunded', outcome: 'waived' },
    });

    expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null })).toEqual({ kind: 'unchanged' });
    expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({ kind: 'unchanged' });
    expect(fake.createRefund).not.toHaveBeenCalled();
  });

  it('tells the teacher once when Mollie answers the create already failed', async () => {
    const c = await settledAttempt();
    fake.createRefund.mockResolvedValue(created('failed'));

    expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: 'waive' })).toEqual({
      kind: 'requested', refundStatus: 'failed', outcomeApplied: false,
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
    expect(await notes('refund_failed', c.classId)).toHaveLength(1);

    await mollieReports(c.attempt, 'failed');
    await syncAttempt(prisma, deps, c.attempt.processorPaymentId);
    expect(await notes('refund_failed', c.classId)).toHaveLength(1);
  });

  it('completes a duplicate’s refund answered already refunded without touching the payment', async () => {
    const c = await duplicateAttempt();
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
    fake.createRefund.mockResolvedValue(created('refunded'));

    expect(await refundAttempt(prisma, deps, { paymentId: c.paymentId, attemptId: c.attempt.id, choice: null })).toEqual({
      kind: 'requested', refundStatus: 'refunded', outcomeApplied: false,
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).updatedAt).toEqual(before.updatedAt);
    expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
  });
});

describe('markPaymentNotCharged on a paid payment', () => {
  it('is still refused PAYMENT_ALREADY_PAID: only a refund’s completion moves paid to not charged', async () => {
    const c = await settledAttempt();
    const outcome = await markPaymentNotCharged(prisma, c.paymentId);
    expect(outcome.kind === 'refused' ? outcome.refusal.code : outcome.kind).toBe('PAYMENT_ALREADY_PAID');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
  });
});

type TransactionFn = (tx: Prisma.TransactionClient) => Promise<unknown>;

/** `prisma` whose every `$transaction` records its raw queries, in order, as one entry of `into`. */
function recordingTransactions(into: string[][]): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn: TransactionFn) => {
          const statements: string[] = [];
          into.push(statements);
          return target.$transaction((tx) => fn(recordRaw(tx, statements)));
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

function recordRaw(tx: Prisma.TransactionClient, into: string[]): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === '$queryRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          into.push(strings.join('?'));
          return target.$queryRaw(strings, ...values);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
