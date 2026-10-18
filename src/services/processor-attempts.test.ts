import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, onTestFinished } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient, Prisma, type PaymentStatus, type PrismaClient, type ProcessorPaymentStatus, type ProcessorRefundStatus, type RefundOutcome } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import { hhmmToTime } from '@/lib/time-of-day';
import { MollieUnavailable, type CreatePaymentInput, type MollieClient, type MolliePaymentView } from '@/lib/mollie/client';
import { MOLLIE_SCOPES } from '@/lib/processor-liveness';
import { paymentReference } from '@/lib/payment-methods';
import { sealToken } from '@/lib/processor-token-cipher';
import { uniqueSuffix } from '../../tests/helpers';
import { createClassFixture } from '../../tests/class-fixtures';
import type { MollieDeps } from './mollie-deps';
import { reopenPayment } from './payments';
import { forgetOfferedMethods } from './processor-methods-cache';
import { ADOPT_AFTER_MS } from './refund-adoption';
import {
  createAttempt, decideRefundSync, decideSync, processorReturnUrl, processorWebhookUrl, syncAttempt,
  type CreateAttemptOutcome, type SyncDecision,
} from './processor-attempts';

const prisma = createPrismaClient();
const key = randomBytes(32);
const MINUTE = 60_000;

type Fake = { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const fake = { refresh: vi.fn(), listMethods: vi.fn(), createPayment: vi.fn(), getPayment: vi.fn() } as unknown as Fake;
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
let otherStudentId = '';
let connectionId = '';
let seededClasses = 0;

async function makeStudent(tag: string): Promise<string> {
  const s = uniqueSuffix();
  const email = `attempt-${tag}-${s}@test.local`;
  const student = await prisma.student.create({
    data: { firstName: 'Stu', lastName: tag, email, claimedAt: new Date(), account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  accountIds.push(student.accountId as string);
  return student.id;
}

async function seedConnection(
  overrides: Partial<{
    disconnectedAt: Date | null; revokeAfter: Date | null; revokedAt: Date | null; scopes: string[]; testmode: boolean;
    accessToken: Uint8Array<ArrayBuffer> | null; refreshToken: Uint8Array<ArrayBuffer> | null; accessTokenExpiresAt: Date | null;
  }> = {},
) {
  await prisma.processorPayment.deleteMany({ where: { connection: { teacherId } } });
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
  const row = await prisma.processorConnection.create({
    data: {
      teacherId,
      processor: 'mollie',
      organizationId: 'org_attempt',
      profileId: 'pfl_attempt',
      accessToken: new Uint8Array(sealToken('access_plain', key)),
      refreshToken: new Uint8Array(sealToken('refresh_plain', key)),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: [...MOLLIE_SCOPES],
      testmode: true,
      ...overrides,
    },
  });
  connectionId = row.id;
  forgetOfferedMethods(row.id);
}

/** A completed euro class with one registration and its payment of 10.00. */
async function freshPayment(status: 'pending' | 'overdue' | 'paid' | 'not_charged' = 'pending') {
  const s = uniqueSuffix();
  const cls = await createClassFixture(prisma, {
    teacherId, teacherRoomId, classType: `Attempt ${s}`, date: new Date(Date.UTC(2026, 4, 1 + seededClasses++)),
    startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: 20, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 10,
    status: 'completed', effectiveTeacherRate: 10, totalStudents: 1, totalRevenue: 30, vatTotal: 0, currency: 'EUR',
  });
  const registration = await prisma.registration.create({ data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 } });
  const payment = await prisma.payment.create({
    data: {
      registrationId: registration.id, amount: 10, status,
      paidAt: status === 'paid' ? new Date() : null,
      notChargedAt: status === 'not_charged' ? new Date() : null,
    },
  });
  return { paymentId: payment.id, entry: cls.calendarEntry };
}

function molliePayment(over: Partial<MolliePaymentView> = {}): MolliePaymentView {
  return {
    id: `tr_${uniqueSuffix().replace(/-/g, '')}`,
    status: 'open',
    method: 'ideal',
    amount: { value: '10.00', currency: 'EUR' },
    checkoutUrl: 'https://www.mollie.com/checkout/select-method/abc',
    expiresAt: new Date(Date.now() + 15 * MINUTE).toISOString(),
    paidAt: null,
    amountChargedBack: null,
    refunds: [],
    ...over,
  };
}

async function seedAttempt(
  paymentId: string,
  method: string,
  expiresAt: Date,
  made: { profileId: string; testmode: boolean } = { profileId: 'pfl_attempt', testmode: true },
) {
  return prisma.processorPayment.create({
    data: {
      paymentId, connectionId, processorPaymentId: `tr_${uniqueSuffix().replace(/-/g, '')}`, method, status: 'open', ...made,
      amount: new Prisma.Decimal('10.00'), currency: 'EUR', checkoutUrl: 'https://www.mollie.com/checkout/seeded', expiresAt,
    },
  });
}

function refusalCode(outcome: CreateAttemptOutcome): string | null {
  return outcome.kind === 'refused' ? outcome.refusal.code : null;
}

beforeAll(async () => {
  const s = uniqueSuffix();
  const email = `attempt-teacher-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Att', lastName: 'Empt', email, bio: '', pageSlug: `attempt-${s}`, currency: 'EUR', account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherId = t.id;
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  const room = await prisma.room.create({
    data: { venueName: 'Attempt Studio', address: `${s} St`, city: 'Amsterdam', postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacherId },
  });
  roomIds.push(room.id);
  teacherRoomId = (await prisma.teacherRoom.create({ data: { teacherId, roomId: room.id, capacityOverride: 15, rentalRate: 25 } })).id;
  studentId = await makeStudent('main');
  otherStudentId = await makeStudent('other');
});

beforeEach(async () => {
  for (const fn of Object.values(fake)) fn.mockReset();
  vi.mocked(logDegraded).mockClear();
  await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: null, currency: 'EUR' } });
  await seedConnection();
  fake.listMethods.mockResolvedValue({ kind: 'methods', methods: ['ideal', 'creditcard', 'klarna'].map((id) => ({ id, description: null })) });
  fake.createPayment.mockImplementation(async () => molliePayment());
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: { in: [...teacherIds, ...studentIds] } } });
  await prisma.processorPayment.deleteMany({ where: { connection: { teacherId: { in: teacherIds } } } });
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

describe('createAttempt', () => {
  it("charges the class's currency, not the teacher's current one, and records the attempt (Review Focus 2)", async () => {
    const { paymentId, entry } = await freshPayment();
    await prisma.teacher.update({ where: { id: teacherId }, data: { currency: 'GBP' } });
    const now = new Date();

    const outcome = await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal', now });

    if (outcome.kind !== 'checkout') throw new Error(`expected checkout, got ${JSON.stringify(outcome)}`);
    expect(fake.listMethods).toHaveBeenCalledWith('access_plain', expect.objectContaining({ amount: { value: '10.00', currency: 'EUR' } }));
    expect(fake.createPayment).toHaveBeenCalledTimes(1);
    const [token, input] = fake.createPayment.mock.calls[0] as [string, CreatePaymentInput];
    expect(token).toBe('access_plain');
    expect(input).toEqual({
      amount: { value: '10.00', currency: 'EUR' },
      description: paymentReference(entry),
      method: 'ideal',
      redirectUrl: processorReturnUrl('https://fair.yoga', paymentId, outcome.attemptId),
      webhookUrl: 'https://fair.yoga/api/webhooks/mollie',
      profileId: 'pfl_attempt',
      metadata: { paymentId, attemptId: outcome.attemptId },
      testmode: true,
    });
    const row = await prisma.processorPayment.findUniqueOrThrow({ where: { id: outcome.attemptId } });
    expect(row).toMatchObject({
      paymentId, connectionId, method: 'ideal', status: 'open', currency: 'EUR', profileId: 'pfl_attempt', testmode: true,
      checkoutUrl: 'https://www.mollie.com/checkout/select-method/abc',
    });
    expect(row.amount.toFixed(2)).toBe('10.00');
    expect(row.expiresAt).not.toBeNull();
    expect(outcome.checkoutUrl).toBe('https://www.mollie.com/checkout/select-method/abc');
  });

  it('reuses an open attempt for the same method that has more than a minute left, without calling Mollie', async () => {
    const { paymentId } = await freshPayment();
    const now = new Date();
    const seeded = await seedAttempt(paymentId, 'ideal', new Date(now.getTime() + 5 * MINUTE));

    const outcome = await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal', now });

    expect(outcome).toEqual({ kind: 'checkout', attemptId: seeded.id, checkoutUrl: 'https://www.mollie.com/checkout/seeded' });
    expect(fake.createPayment).not.toHaveBeenCalled();
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('does not reuse an attempt for another method, or one expiring within a minute', async () => {
    const { paymentId } = await freshPayment();
    const now = new Date();
    const otherMethod = await seedAttempt(paymentId, 'creditcard', new Date(now.getTime() + 20 * MINUTE));
    const expiring = await seedAttempt(paymentId, 'ideal', new Date(now.getTime() + 30_000));

    const outcome = await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal', now });

    if (outcome.kind !== 'checkout') throw new Error(`expected checkout, got ${JSON.stringify(outcome)}`);
    expect([otherMethod.id, expiring.id]).not.toContain(outcome.attemptId);
    expect(fake.createPayment).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an attempt made under another profile', async () => {
    const { paymentId } = await freshPayment();
    const now = new Date();
    const old = await seedAttempt(paymentId, 'ideal', new Date(now.getTime() + 10 * MINUTE), { profileId: 'pfl_previous', testmode: true });

    const outcome = await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal', now });

    if (outcome.kind !== 'checkout') throw new Error(`expected checkout, got ${JSON.stringify(outcome)}`);
    expect(outcome.attemptId).not.toBe(old.id);
    expect(fake.createPayment).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an attempt made in the other mode', async () => {
    const { paymentId } = await freshPayment();
    const now = new Date();
    const old = await seedAttempt(paymentId, 'ideal', new Date(now.getTime() + 10 * MINUTE), { profileId: 'pfl_attempt', testmode: false });

    const outcome = await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal', now });

    if (outcome.kind !== 'checkout') throw new Error(`expected checkout, got ${JSON.stringify(outcome)}`);
    expect(outcome.attemptId).not.toBe(old.id);
    expect(fake.createPayment).toHaveBeenCalledTimes(1);
  });

  describe('refuses before reusing', () => {
    it('a paused teacher with PAYMENTS_PAUSED, though a reusable attempt exists', async () => {
      const { paymentId } = await freshPayment();
      await seedAttempt(paymentId, 'ideal', new Date(Date.now() + 10 * MINUTE));
      await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: new Date() } });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PAYMENTS_PAUSED');
    });

    it('a settled payment with PAYMENT_SETTLED, though a reusable attempt exists', async () => {
      const { paymentId } = await freshPayment();
      await seedAttempt(paymentId, 'ideal', new Date(Date.now() + 10 * MINUTE));
      await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid', paidAt: new Date() } });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PAYMENT_SETTLED');
    });
  });

  describe('refuses', () => {
    it("another student's payment with NOT_FOUND", async () => {
      const { paymentId } = await freshPayment();
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId: otherStudentId, method: 'ideal' }))).toBe('NOT_FOUND');
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it.each(['paid', 'not_charged'] as const)('a %s payment with PAYMENT_SETTLED', async (status) => {
      const { paymentId } = await freshPayment(status);
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PAYMENT_SETTLED');
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it('a paused teacher with PAYMENTS_PAUSED', async () => {
      const { paymentId } = await freshPayment();
      await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: new Date() } });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PAYMENTS_PAUSED');
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it('no connection with PROCESSOR_NOT_CONNECTED, also when Mollie is not configured', async () => {
      const { paymentId } = await freshPayment();
      await prisma.processorConnection.deleteMany({ where: { teacherId } });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(refusalCode(await createAttempt(prisma, null, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
    });

    it('a disconnected connection with PROCESSOR_NOT_CONNECTED, without calling Mollie', async () => {
      const { paymentId } = await freshPayment();
      const at = new Date();
      await seedConnection({ disconnectedAt: at, revokeAfter: at });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(fake.listMethods).not.toHaveBeenCalled();
    });

    it('a connection whose grant lacks a requested scope with PROCESSOR_NOT_CONNECTED, without calling Mollie', async () => {
      const { paymentId } = await freshPayment();
      await seedConnection({ scopes: MOLLIE_SCOPES.filter((s) => s !== 'payments.write') });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(fake.listMethods).not.toHaveBeenCalled();
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it.each([
      ['made in test mode, on a server now live', true, false],
      ['made live, on a server now in test mode', false, true],
    ])('a connection %s with PROCESSOR_NOT_CONNECTED, without calling Mollie', async (_label, made, serverTestmode) => {
      const { paymentId } = await freshPayment();
      await seedConnection({ testmode: made });
      const server = { ...deps, config: { ...deps.config, testmode: serverTestmode } };
      expect(refusalCode(await createAttempt(prisma, server, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(fake.listMethods).not.toHaveBeenCalled();
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it('a method off the allowlist with PROCESSOR_METHOD_UNAVAILABLE', async () => {
      const { paymentId } = await freshPayment();
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'klarna' }))).toBe('PROCESSOR_METHOD_UNAVAILABLE');
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it('an allowlisted method the teacher does not offer for this payment with PROCESSOR_METHOD_UNAVAILABLE', async () => {
      const { paymentId } = await freshPayment();
      fake.listMethods.mockResolvedValue({ kind: 'methods', methods: ['creditcard'].map((id) => ({ id, description: null })) });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_METHOD_UNAVAILABLE');
      expect(fake.createPayment).not.toHaveBeenCalled();
    });
  });

  it('answers unavailable when Mollie is not configured for a live connection', async () => {
    const { paymentId } = await freshPayment();
    expect(await createAttempt(prisma, null, { paymentId, studentId, method: 'ideal' })).toEqual({ kind: 'unavailable' });
  });

  it('answers unavailable when the methods list cannot be read', async () => {
    const { paymentId } = await freshPayment();
    fake.listMethods.mockRejectedValue(new MollieUnavailable('down', 503));
    expect(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' })).toEqual({ kind: 'unavailable' });
    expect(fake.createPayment).not.toHaveBeenCalled();
  });

  it('answers unavailable, writes no attempt and logs when createPayment fails', async () => {
    const { paymentId } = await freshPayment();
    fake.createPayment.mockRejectedValue(new MollieUnavailable('down', 502));
    expect(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' })).toEqual({ kind: 'unavailable' });
    expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
    expect(vi.mocked(logDegraded)).toHaveBeenCalledWith(
      'MOLLIE_UNAVAILABLE',
      { connectionId, operation: 'createPayment', status: 502 },
      expect.any(String),
      expect.any(MollieUnavailable),
    );
  });

  describe('when the row changes while Mollie is called', () => {
    it('records nothing and refuses PROCESSOR_NOT_CONNECTED on a connection disconnected meanwhile', async () => {
      const { paymentId } = await freshPayment();
      const at = new Date();
      fake.createPayment.mockImplementation(async () => {
        await prisma.processorConnection.update({ where: { id: connectionId }, data: { disconnectedAt: at, revokeAfter: at } });
        return molliePayment();
      });

      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');

      expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
      expect((await prisma.processorConnection.findUniqueOrThrow({ where: { id: connectionId } })).revokeAfter).toEqual(at);
    });

    it('records nothing and refuses PROCESSOR_NOT_CONNECTED on a profile cleared meanwhile', async () => {
      const { paymentId } = await freshPayment();
      fake.createPayment.mockImplementation(async () => {
        await prisma.processorConnection.update({ where: { id: connectionId }, data: { profileId: null } });
        return molliePayment();
      });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
    });

    it('records nothing and refuses PROCESSOR_NOT_CONNECTED on a connection revoked meanwhile', async () => {
      const { paymentId } = await freshPayment();
      fake.createPayment.mockImplementation(async () => {
        const at = new Date();
        await prisma.processorConnection.update({
          where: { id: connectionId },
          data: { disconnectedAt: at, revokeAfter: at, revokedAt: at, accessToken: null, refreshToken: null, accessTokenExpiresAt: null },
        });
        return molliePayment();
      });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
    });

    it('records nothing and refuses PROCESSOR_NOT_CONNECTED on a connection remade in the other mode meanwhile', async () => {
      const { paymentId } = await freshPayment();
      fake.createPayment.mockImplementation(async () => {
        await prisma.processorConnection.update({ where: { id: connectionId }, data: { testmode: false } });
        return molliePayment();
      });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PROCESSOR_NOT_CONNECTED');
      expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
    });

    it('records nothing and refuses PAYMENT_SETTLED on a payment marked paid meanwhile', async () => {
      const { paymentId } = await freshPayment();
      fake.createPayment.mockImplementation(async () => {
        await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid', paidAt: new Date() } });
        return molliePayment();
      });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PAYMENT_SETTLED');
      expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
    });

    it('records nothing and refuses PAYMENTS_PAUSED on a teacher paused meanwhile', async () => {
      const { paymentId } = await freshPayment();
      fake.createPayment.mockImplementation(async () => {
        await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: new Date() } });
        return molliePayment();
      });
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' }))).toBe('PAYMENTS_PAUSED');
      expect(await prisma.processorPayment.count({ where: { paymentId } })).toBe(0);
    });
  });
});

describe('processor URLs', () => {
  it('builds the return URL for a payment and attempt', () => {
    expect(processorReturnUrl('https://fair.yoga', 'pay-1', 'att-1')).toBe('https://fair.yoga/api/payments/pay-1/processor-return?attempt=att-1');
  });
  it('encodes the ids it carries', () => {
    expect(processorReturnUrl('https://fair.yoga', 'a/b', 'c&d=e')).toBe('https://fair.yoga/api/payments/a%2Fb/processor-return?attempt=c%26d%3De');
  });
  it('omits the webhook on a host Mollie cannot reach', () => {
    expect(processorWebhookUrl('http://localhost:3000')).toBeNull();
    expect(processorWebhookUrl('http://127.0.0.1:3164')).toBeNull();
    expect(processorWebhookUrl('http://[::1]:3000')).toBeNull();
    expect(processorWebhookUrl('http://0.0.0.0:3000')).toBeNull();
    expect(processorWebhookUrl('https://fair.yoga')).toBe('https://fair.yoga/api/webhooks/mollie');
  });
});

describe('decideSync', () => {
  const quiet = (attemptStatus: ProcessorPaymentStatus): SyncDecision => ({
    attemptStatus, settle: false, notifyPaidTwice: false, recordChargeback: false, result: 'unchanged',
  });
  const statusOnly = (attemptStatus: ProcessorPaymentStatus): SyncDecision => ({
    attemptStatus, settle: false, notifyPaidTwice: false, recordChargeback: false, result: 'status_only',
  });
  const chargedBack: SyncDecision = { attemptStatus: 'paid', settle: false, notifyPaidTwice: false, recordChargeback: true, result: 'charged_back' };
  const settled: SyncDecision = { attemptStatus: 'paid', settle: true, notifyPaidTwice: false, recordChargeback: false, result: 'settled' };
  const paidTwice: SyncDecision = { attemptStatus: 'paid', settle: false, notifyPaidTwice: true, recordChargeback: false, result: 'paid_twice' };

  type Input = Parameters<typeof decideSync>[0];
  const row = (over: Partial<Input> & Pick<Input, 'mollieStatus' | 'previousStatus' | 'paymentStatus'>): Input => ({
    settledByThis: false, chargedBack: false, alreadyChargedBack: false, ...over,
  });

  it.each<[string, Input, SyncDecision]>([
    ['a chargeback on the settling attempt', row({ mollieStatus: 'paid', previousStatus: 'paid', paymentStatus: 'paid', settledByThis: true, chargedBack: true }), chargedBack],
    ['a chargeback on a duplicate', row({ mollieStatus: 'paid', previousStatus: 'paid', paymentStatus: 'paid', chargedBack: true }), chargedBack],
    ['a chargeback the first webhook reports, without settling', row({ mollieStatus: 'paid', previousStatus: 'open', paymentStatus: 'pending', chargedBack: true }), chargedBack],
    ['a chargeback already recorded', row({ mollieStatus: 'paid', previousStatus: 'paid', paymentStatus: 'paid', chargedBack: true, alreadyChargedBack: true }), quiet('paid')],
    ['paid on a pending payment', row({ mollieStatus: 'paid', previousStatus: 'open', paymentStatus: 'pending' }), settled],
    ['paid on an overdue payment', row({ mollieStatus: 'paid', previousStatus: 'open', paymentStatus: 'overdue' }), settled],
    ['paid again by the attempt that settled it', row({ mollieStatus: 'paid', previousStatus: 'paid', paymentStatus: 'paid', settledByThis: true }), quiet('paid')],
    ['paid on a payment settled otherwise', row({ mollieStatus: 'paid', previousStatus: 'open', paymentStatus: 'paid' }), paidTwice],
    ['paid on a waived payment', row({ mollieStatus: 'paid', previousStatus: 'open', paymentStatus: 'not_charged' }), paidTwice],
    ['paid twice, already told', row({ mollieStatus: 'paid', previousStatus: 'paid', paymentStatus: 'paid' }), quiet('paid')],
    ['paid again by an attempt a refund released, on a payment asked again', row({ mollieStatus: 'paid', previousStatus: 'paid', paymentStatus: 'pending' }), quiet('paid')],
    ['an earlier status reported for a paid attempt', row({ mollieStatus: 'pending', previousStatus: 'paid', paymentStatus: 'paid', settledByThis: true }), quiet('paid')],
  ])('%s', (_label, input, expected) => {
    expect(decideSync(input)).toEqual(expected);
  });

  it.each<ProcessorPaymentStatus>(['pending', 'authorized', 'canceled', 'expired', 'failed'])('%s records the status only, on any payment', (status) => {
    for (const paymentStatus of ['pending', 'overdue', 'paid', 'not_charged'] satisfies PaymentStatus[]) {
      expect(decideSync(row({ mollieStatus: status, previousStatus: 'open', paymentStatus }))).toEqual(statusOnly(status));
      expect(decideSync(row({ mollieStatus: status, previousStatus: status, paymentStatus }))).toEqual(quiet(status));
    }
  });
});

describe('decideRefundSync', () => {
  const ALL: ProcessorRefundStatus[] = ['queued', 'pending', 'processing', 'refunded', 'failed', 'canceled'];
  const OPEN: ProcessorRefundStatus[] = ['queued', 'pending', 'processing'];
  const FINAL: ProcessorRefundStatus[] = ['refunded', 'failed', 'canceled'];

  it.each(ALL)('%s reported again is unchanged', (status) => {
    expect(decideRefundSync({ storedStatus: status, mollieStatus: status })).toEqual({ kind: 'unchanged' });
  });

  it.each(OPEN)('a %s row reported refunded completes', (storedStatus) => {
    expect(decideRefundSync({ storedStatus, mollieStatus: 'refunded' })).toEqual({ kind: 'status', status: 'refunded', complete: true, notifyFailed: false });
  });

  it.each(OPEN)('a %s row reported failed tells the teacher', (storedStatus) => {
    expect(decideRefundSync({ storedStatus, mollieStatus: 'failed' })).toEqual({ kind: 'status', status: 'failed', complete: false, notifyFailed: true });
  });

  it.each(OPEN.flatMap((from) => [...OPEN, 'canceled' as const].filter((to) => to !== from).map((to) => [from, to] as const)))('%s → %s records the status only', (storedStatus, mollieStatus) => {
    expect(decideRefundSync({ storedStatus, mollieStatus })).toEqual({ kind: 'status', status: mollieStatus, complete: false, notifyFailed: false });
  });

  it.each(FINAL.flatMap((from) => ALL.map((to) => [from, to] as const)))('a %s row is never moved (to %s)', (storedStatus, mollieStatus) => {
    expect(decideRefundSync({ storedStatus, mollieStatus })).toEqual({ kind: 'unchanged' });
  });
});

describe('syncAttempt', () => {
  const trId = () => `tr_${uniqueSuffix().replace(/-/g, '')}`;
  const reId = () => `re_${uniqueSuffix().replace(/-/g, '')}`;

  /** A payment of 10.00 and one Mollie attempt on it. */
  async function attemptOn(
    paymentStatus: 'pending' | 'overdue' | 'paid' | 'not_charged',
    attempt: Partial<{ status: ProcessorPaymentStatus; settledPayment: boolean; chargedBackAt: Date | null; testmode: boolean; connectionId: string | null; method: string }> = {},
    paymentMethod: 'manual' | 'mollie' | null = null,
  ) {
    const { paymentId } = await freshPayment(paymentStatus);
    if (paymentMethod !== null) await prisma.payment.update({ where: { id: paymentId }, data: { method: paymentMethod } });
    const row = await prisma.processorPayment.create({
      data: {
        paymentId, connectionId, processorPaymentId: trId(), profileId: 'pfl_attempt', testmode: true, method: 'ideal', status: 'open',
        amount: new Prisma.Decimal('10.00'), currency: 'EUR', checkoutUrl: 'https://www.mollie.com/checkout/seeded',
        expiresAt: new Date(Date.now() + 10 * MINUTE),
        ...(attempt.status === 'paid' ? { paidAt: new Date() } : {}),
        ...attempt,
      },
    });
    return { paymentId, attempt: row };
  }

  /** A payment Mollie settled through one attempt. */
  function settledAttempt(over: Partial<{ chargedBackAt: Date | null; settledPayment: boolean }> = {}) {
    return attemptOn('paid', { status: 'paid', settledPayment: true, ...over }, 'mollie');
  }

  function view(processorPaymentId: string, over: Partial<MolliePaymentView> = {}): MolliePaymentView {
    return molliePayment({ id: processorPaymentId, status: 'paid', paidAt: new Date().toISOString(), checkoutUrl: null, ...over });
  }

  function refundRow(attemptId: string, over: Partial<{ processorRefundId: string | null; status: ProcessorRefundStatus; outcome: RefundOutcome | null }> = {}) {
    return prisma.processorRefund.create({
      data: { attemptId, processorRefundId: reId(), amount: new Prisma.Decimal('10.00'), status: 'queued', outcome: null, ...over },
    });
  }

  function notes(type: 'payment_paid_twice' | 'payment_charged_back' | 'refund_failed' | 'payment_refunded', classId?: string) {
    return prisma.notification.findMany({
      where: { type, recipientId: { in: [teacherId, studentId] }, ...(classId ? { relatedClassId: classId } : {}) },
    });
  }

  async function classOf(paymentId: string): Promise<string> {
    return (await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { registration: { select: { classId: true } } } })).registration.classId;
  }

  it('answers unknown for an id no attempt has, without calling Mollie', async () => {
    expect(await syncAttempt(prisma, deps, trId())).toBe('unknown');
    expect(fake.getPayment).not.toHaveBeenCalled();
  });

  it('answers unknown for an id no attempt has without logging it, since it is not fair.yoga’s', async () => {
    expect(await syncAttempt(prisma, deps, trId())).toBe('unknown');
    expect(logDegraded).not.toHaveBeenCalled();
  });

  it('answers unknown and logs PROCESSOR_PAYMENT_UNCONFIRMED for an attempt whose connection is gone, without calling Mollie (Review Focus 4)', async () => {
    const { attempt } = await attemptOn('pending', { connectionId: null });
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unknown');
    expect(fake.getPayment).not.toHaveBeenCalled();
    expect(vi.mocked(logDegraded).mock.calls).toEqual([[
      'PROCESSOR_PAYMENT_UNCONFIRMED',
      { attemptId: attempt.id, processorPaymentId: attempt.processorPaymentId, reason: 'teacher_erased' },
      expect.any(String),
    ]]);
  });

  it("settles a pending payment Mollie reports paid, and records Mollie's method", async () => {
    const { paymentId, attempt } = await attemptOn('pending');
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { method: 'creditcard' }));

    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('settled');

    expect(fake.getPayment).toHaveBeenCalledWith('access_plain', attempt.processorPaymentId, { testmode: true });
    const row = await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row).toMatchObject({ status: 'paid', settledPayment: true, method: 'creditcard' });
    expect(row.paidAt).not.toBeNull();
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment).toMatchObject({ status: 'paid', method: 'mollie' });
    expect(payment.paidAt).not.toBeNull();
  });

  it('writes nothing for the same webhook again', async () => {
    const { paymentId, attempt } = await attemptOn('pending');
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId));
    await syncAttempt(prisma, deps, attempt.processorPaymentId);
    const before = await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } });
    const paymentBefore = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');

    expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).updatedAt).toEqual(before.updatedAt);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).updatedAt).toEqual(paymentBefore.updatedAt);
  });

  it("answers the webhook unchanged after the student's return settled it (Review Focus 5)", async () => {
    const { attempt } = await attemptOn('pending');
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId));
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('settled'); // the return route's call
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged'); // the webhook's
  });

  it('records a payment already paid by hand as paid twice and tells the teacher once', async () => {
    const { paymentId, attempt } = await attemptOn('paid', {}, 'manual');
    const paymentBefore = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId));

    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('paid_twice');

    expect(await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'paid', settledPayment: false });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.method).toBe('manual');
    expect(payment.updatedAt).toEqual(paymentBefore.updatedAt);
    const classId = await classOf(paymentId);
    const sent = await notes('payment_paid_twice', classId);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipientType: 'teacher', recipientId: teacherId, title: 'Paid twice' });
    expect(sent[0]!.body).toBe('Stu also paid €10.00 by iDEAL. You can refund it from the payment.');

    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');
    expect(await notes('payment_paid_twice', classId)).toHaveLength(1);
  });

  it('answers unknown and logs PROCESSOR_PAYMENT_UNCONFIRMED when Mollie no longer knows an attempt we hold', async () => {
    const { attempt } = await attemptOn('pending');
    fake.getPayment.mockResolvedValue(null);
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unknown');
    expect(vi.mocked(logDegraded).mock.calls).toEqual([[
      'PROCESSOR_PAYMENT_UNCONFIRMED',
      { attemptId: attempt.id, connectionId, processorPaymentId: attempt.processorPaymentId, reason: 'mollie_unknown' },
      expect.any(String),
    ]]);
  });

  it('answers unavailable and logs MOLLIE_UNAVAILABLE when Mollie cannot be reached', async () => {
    const { paymentId, attempt } = await attemptOn('pending');
    fake.getPayment.mockRejectedValue(new MollieUnavailable('down', 503));
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unavailable');
    expect(vi.mocked(logDegraded)).toHaveBeenCalledWith(
      'MOLLIE_UNAVAILABLE',
      { connectionId, operation: 'getPayment', status: 503 },
      expect.any(String),
      expect.any(MollieUnavailable),
    );
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('pending');
  });

  it('answers unavailable for a known attempt when Mollie is not configured', async () => {
    const { attempt } = await attemptOn('pending');
    expect(await syncAttempt(prisma, null, attempt.processorPaymentId)).toBe('unavailable');
  });

  it('answers unknown and logs PROCESSOR_PAYMENT_UNCONFIRMED when the connection was revoked', async () => {
    const at = new Date();
    await seedConnection({ disconnectedAt: at, revokedAt: at, accessToken: null, refreshToken: null, accessTokenExpiresAt: null });
    const { attempt } = await attemptOn('pending');
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unknown');
    expect(fake.getPayment).not.toHaveBeenCalled();
    expect(vi.mocked(logDegraded).mock.calls).toEqual([[
      'PROCESSOR_PAYMENT_UNCONFIRMED',
      { attemptId: attempt.id, connectionId, processorPaymentId: attempt.processorPaymentId, reason: 'connection_revoked' },
      expect.any(String),
    ]]);
  });

  it('answers unknown and logs PROCESSOR_PAYMENT_UNCONFIRMED for a status Mollie does not document', async () => {
    const { paymentId, attempt } = await attemptOn('pending');
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { status: 'settled' }));
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unknown');
    expect(vi.mocked(logDegraded).mock.calls).toEqual([[
      'PROCESSOR_PAYMENT_UNCONFIRMED',
      { attemptId: attempt.id, connectionId, processorPaymentId: attempt.processorPaymentId, reason: 'status_unknown', mollieStatus: 'settled' },
      expect.any(String),
    ]]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('pending');
  });

  it('fetches in the mode the attempt was made in, not the connection’s current one', async () => {
    await seedConnection({ testmode: false });
    const { attempt } = await attemptOn('pending', { testmode: true });
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { status: 'open' }));
    await syncAttempt(prisma, deps, attempt.processorPaymentId);
    expect(fake.getPayment).toHaveBeenCalledWith('access_plain', attempt.processorPaymentId, { testmode: true });
  });

  it.each<ProcessorPaymentStatus>(['pending', 'authorized', 'canceled', 'expired', 'failed'])('records %s on the attempt only', async (status) => {
    const { paymentId, attempt } = await attemptOn('pending');
    fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { status, paidAt: null }));
    expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('status_only');
    const row = await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row).toMatchObject({ status, settledPayment: false, paidAt: null });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('pending');
  });

  describe('a chargeback', () => {
    it('releases the settling attempt, leaves the payment paid, and tells the teacher once', async () => {
      const { paymentId, attempt } = await settledAttempt();
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { amountChargedBack: { value: '4.00', currency: 'EUR' } }));

      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('charged_back');

      const row = await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } });
      expect(row.chargedBackAt).not.toBeNull();
      expect(row.settledPayment).toBe(false);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('paid');
      const classId = await classOf(paymentId);
      const sent = await notes('payment_charged_back', classId);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ recipientType: 'teacher', recipientId: teacherId, title: 'Payment disputed' });
      expect(sent[0]!.body).toBe('Stu disputed €4.00 with their bank and it was taken back. You can mark the payment unpaid to ask again.');

      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');
      expect(await notes('payment_charged_back', classId)).toHaveLength(1);
    });

    it('names the attempt’s amount, and logs, when Mollie reports the chargeback in another currency', async () => {
      const warn = vi.spyOn(log, 'warn');
      onTestFinished(() => warn.mockRestore());
      const { paymentId, attempt } = await settledAttempt();
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { amountChargedBack: { value: '4.00', currency: 'USD' } }));
      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('charged_back');
      const [sent] = await notes('payment_charged_back', await classOf(paymentId));
      expect(sent!.body).toBe('Stu disputed €10.00 with their bank and it was taken back. You can mark the payment unpaid to ask again.');
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ attemptId: attempt.id, chargedBackCurrency: 'USD' }), expect.any(String));
    });

    it('on a duplicate attempt tells the teacher without offering to ask again', async () => {
      const { paymentId, attempt } = await attemptOn('paid', { status: 'paid' }, 'manual');
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { amountChargedBack: { value: '10.00', currency: 'EUR' } }));
      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('charged_back');
      const [sent] = await notes('payment_charged_back', await classOf(paymentId));
      expect(sent!.body).toBe('Stu disputed €10.00 with their bank and it was taken back.');
    });

    it('lets the teacher reopen, and a second attempt then settles through the sync', async () => {
      const { paymentId, attempt } = await settledAttempt();
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { amountChargedBack: { value: '10.00', currency: 'EUR' } }));
      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('charged_back');

      expect((await reopenPayment(prisma, paymentId)).kind).toBe('applied');

      const second = await prisma.processorPayment.create({
        data: {
          paymentId, connectionId, processorPaymentId: trId(), profileId: 'pfl_attempt', testmode: true, method: 'creditcard', status: 'open',
          amount: new Prisma.Decimal('10.00'), currency: 'EUR', checkoutUrl: 'https://www.mollie.com/checkout/second',
          expiresAt: new Date(Date.now() + 10 * MINUTE),
        },
      });
      fake.getPayment.mockResolvedValue(view(second.processorPaymentId, { method: 'creditcard' }));
      expect(await syncAttempt(prisma, deps, second.processorPaymentId)).toBe('settled');

      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: second.id } })).settledPayment).toBe(true);
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(false);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({ status: 'paid', method: 'mollie' });
    });

    it('of zero is not a chargeback', async () => {
      const { attempt } = await settledAttempt();
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { amountChargedBack: { value: '0.00', currency: 'EUR' } }));
      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(true);
    });
  });

  describe('refunds', () => {
    async function refundCase(outcome: RefundOutcome | null, refundStatus: ProcessorRefundStatus) {
      const settled = outcome === null ? await attemptOn('paid', { status: 'paid' }, 'manual') : await settledAttempt();
      const refund = await refundRow(settled.attempt.id, { outcome });
      fake.getPayment.mockResolvedValue(
        view(settled.attempt.processorPaymentId, { refunds: [{ id: refund.processorRefundId!, status: refundStatus, amount: { value: '10.00', currency: 'EUR' } }] }),
      );
      return { ...settled, refund, classId: await classOf(settled.paymentId) };
    }

    it('of a duplicate completes without touching the payment, telling the student once', async () => {
      const c = await refundCase(null, 'refunded');
      const before = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });

      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);

      expect((await prisma.processorRefund.findUniqueOrThrow({ where: { id: c.refund.id } })).status).toBe('refunded');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).updatedAt).toEqual(before.updatedAt);
      const sent = await notes('payment_refunded', c.classId);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ recipientType: 'student', recipientId: studentId, title: 'Payment refunded' });
      expect(sent[0]!.body).toBe('Att refunded €10.00. It goes back the way you paid.');

      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
    });

    it('with outcome waived marks the payment not charged and releases the attempt', async () => {
      const c = await refundCase('waived', 'refunded');
      await prisma.payment.update({ where: { id: c.paymentId }, data: { studentReportedAt: new Date() } });

      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
      expect(payment.status).toBe('not_charged');
      expect(payment.notChargedAt).not.toBeNull();
      expect(payment.studentReportedAt).toBeNull();
      expect(payment.method).toBeNull();
      expect(payment.paidAt).toBeNull();
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(false);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
    });

    it('with outcome reopened asks again, taking the link lock before the payment', async () => {
      const c = await refundCase('reopened', 'refunded');
      const statements: string[] = [];
      const recording = withTransaction(async (fn) =>
        prisma.$transaction((tx) => fn(recordRaw(tx, statements))),
      );

      await syncAttempt(recording, deps, c.attempt.processorPaymentId);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } });
      expect(payment).toMatchObject({ status: 'pending', method: null, paidAt: null });
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(false);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
      const link = statements.findIndex((s) => s.includes('"TeacherStudent"'));
      const paymentLock = statements.findIndex((s) => s.includes('"Payment"') && s.includes('FOR UPDATE'));
      expect(link).toBeGreaterThanOrEqual(0);
      expect(link).toBeLessThan(paymentLock);
    });

    it('still processing changes no payment and tells no one', async () => {
      const c = await refundCase('reopened', 'processing');
      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);
      expect((await prisma.processorRefund.findUniqueOrThrow({ where: { id: c.refund.id } })).status).toBe('processing');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(true);
      expect(await notes('payment_refunded', c.classId)).toHaveLength(0);
    });

    it('that failed leaves the payment paid and tells the teacher', async () => {
      const c = await refundCase('waived', 'failed');
      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);
      expect((await prisma.processorRefund.findUniqueOrThrow({ where: { id: c.refund.id } })).status).toBe('failed');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('paid');
      expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: c.attempt.id } })).settledPayment).toBe(true);
      const sent = await notes('refund_failed', c.classId);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ recipientType: 'teacher', recipientId: teacherId });
      expect(sent[0]!.body).toBe('A refund didn’t go through. Check your Mollie balance and try again from the payment.');
      expect(await notes('payment_refunded', c.classId)).toHaveLength(0);
    });

    it('whose payment is no longer paid applies nothing, logs it, and still tells the student', async () => {
      const warn = vi.spyOn(log, 'warn');
      onTestFinished(() => warn.mockRestore());
      const c = await refundCase('waived', 'refunded');
      await prisma.payment.update({ where: { id: c.paymentId }, data: { status: 'pending', method: null, paidAt: null } });

      await syncAttempt(prisma, deps, c.attempt.processorPaymentId);

      expect((await prisma.processorRefund.findUniqueOrThrow({ where: { id: c.refund.id } })).status).toBe('refunded');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: c.paymentId } })).status).toBe('pending');
      expect(warn).toHaveBeenCalledWith({ paymentId: c.paymentId, attemptId: c.attempt.id, outcome: 'waived' }, expect.any(String));
      expect(await notes('payment_refunded', c.classId)).toHaveLength(1);
    });

    describe("made in Mollie's dashboard", () => {
      const eur = (value: string) => ({ value, currency: 'EUR' });

      it('in full releases the attempt like a chargeback, leaving the payment paid, so Mark unpaid applies', async () => {
        const info = vi.spyOn(log, 'info');
        onTestFinished(() => info.mockRestore());
        const { paymentId, attempt } = await settledAttempt();
        const dashboard = reId();
        fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { refunds: [{ id: dashboard, status: 'refunded', amount: eur('10.00') }] }));

        expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');

        expect(await prisma.processorRefund.count({ where: { processorRefundId: dashboard } })).toBe(0);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('paid');
        expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(false);
        expect(info).toHaveBeenCalledWith(expect.objectContaining({ attemptId: attempt.id, refundIds: [dashboard] }), expect.any(String));
        expect(await notes('payment_refunded', await classOf(paymentId))).toHaveLength(0);
        expect((await reopenPayment(prisma, paymentId)).kind).toBe('applied');
      });

      it('in two parts that together cover the attempt releases it', async () => {
        const { attempt } = await settledAttempt();
        fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, {
          refunds: [{ id: reId(), status: 'refunded', amount: eur('4.00') }, { id: reId(), status: 'refunded', amount: eur('6.00') }],
        }));
        await syncAttempt(prisma, deps, attempt.processorPaymentId);
        expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(false);
      });

      it.each([
        ['partial', [{ status: 'refunded', value: '4.00' }]],
        ['still pending', [{ status: 'pending', value: '10.00' }]],
        ['refunded in part, the rest pending', [{ status: 'refunded', value: '4.00' }, { status: 'processing', value: '6.00' }]],
      ] as const)('%s changes nothing', async (_label, parts) => {
        const { paymentId, attempt } = await settledAttempt();
        fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, {
          refunds: parts.map((p) => ({ id: reId(), status: p.status, amount: eur(p.value) })),
        }));
        expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');
        expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(true);
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('paid');
      });
    });

    it('with no row while a fair.yoga refund awaits its Mollie id answers unavailable and writes nothing for it', async () => {
      const info = vi.spyOn(log, 'warn');
      onTestFinished(() => info.mockRestore());
      const { paymentId, attempt } = await settledAttempt();
      const awaiting = await refundRow(attempt.id, { processorRefundId: null, outcome: 'waived' });
      const unseen = reId();
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { refunds: [{ id: unseen, status: 'refunded', amount: { value: '10.00', currency: 'EUR' } }] }));

      expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unavailable');

      expect(await prisma.processorRefund.findUniqueOrThrow({ where: { id: awaiting.id } })).toMatchObject({ status: 'queued', processorRefundId: null });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('paid');
      expect(await notes('payment_refunded', await classOf(paymentId))).toHaveLength(0);
      expect(info).toHaveBeenCalledWith(expect.objectContaining({ attemptId: attempt.id, deferred: true, refundIds: [unseen] }), expect.any(String));
    });

    describe('adopting a refund into an intent that never stored its Mollie id', () => {
      const old = () => new Date(Date.now() - ADOPT_AFTER_MS - 60_000);

      it.each([
        ['waived', 'not_charged'],
        ['reopened', 'pending'],
      ] as const)('adopts an old awaiting row with outcome %s and applies it, payment %s', async (outcome, paymentStatus) => {
        const info = vi.spyOn(log, 'info');
        onTestFinished(() => info.mockRestore());
        const { paymentId, attempt } = await settledAttempt();
        const awaiting = await prisma.processorRefund.create({
          data: { attemptId: attempt.id, processorRefundId: null, amount: new Prisma.Decimal('10.00'), status: 'queued', outcome, requestedAt: old() },
        });
        const mollieRefundId = reId();
        fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { refunds: [{ id: mollieRefundId, status: 'refunded', amount: { value: '10.00', currency: 'EUR' } }] }));

        await syncAttempt(prisma, deps, attempt.processorPaymentId);

        expect(await prisma.processorRefund.findUniqueOrThrow({ where: { id: awaiting.id } })).toMatchObject({ processorRefundId: mollieRefundId, status: 'refunded' });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe(paymentStatus);
        expect(await notes('payment_refunded', await classOf(paymentId))).toHaveLength(1);
        expect(info).toHaveBeenCalledWith(expect.objectContaining({ attemptId: attempt.id, refundId: awaiting.id, mollieRefundId }), expect.any(String));
      });

      it('ignores a refund whose amount no old awaiting row has', async () => {
        const { paymentId, attempt } = await settledAttempt();
        const awaiting = await prisma.processorRefund.create({
          data: { attemptId: attempt.id, processorRefundId: null, amount: new Prisma.Decimal('10.00'), status: 'queued', outcome: 'waived', requestedAt: old() },
        });
        fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { refunds: [{ id: reId(), status: 'refunded', amount: { value: '3.00', currency: 'EUR' } }] }));

        expect(await syncAttempt(prisma, deps, attempt.processorPaymentId)).toBe('unchanged');

        expect(await prisma.processorRefund.findUniqueOrThrow({ where: { id: awaiting.id } })).toMatchObject({ processorRefundId: null, status: 'queued' });
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('paid');
      });
    });

    it('stored between the pre-read and the lock, outcome reopened, defers rather than lock the link after the payment', async () => {
      const { paymentId, attempt } = await settledAttempt();
      const refund = await refundRow(attempt.id, { processorRefundId: null, outcome: 'reopened' });
      const mollieRefundId = reId();
      fake.getPayment.mockResolvedValue(view(attempt.processorPaymentId, { refunds: [{ id: mollieRefundId, status: 'refunded', amount: { value: '10.00', currency: 'EUR' } }] }));
      const storing = withTransaction(async (fn) => {
        await prisma.processorRefund.update({ where: { id: refund.id }, data: { processorRefundId: mollieRefundId, status: 'queued' } });
        return prisma.$transaction(fn);
      });

      expect(await syncAttempt(storing, deps, attempt.processorPaymentId)).toBe('unavailable');

      expect((await prisma.processorRefund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('queued');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('paid');
      expect(await notes('payment_refunded', await classOf(paymentId))).toHaveLength(0);

      await syncAttempt(prisma, deps, attempt.processorPaymentId);
      expect((await prisma.processorRefund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('refunded');
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status).toBe('pending');
    });
  });
});

type TransactionFn = (tx: Prisma.TransactionClient) => Promise<unknown>;

/** `prisma` with only `$transaction` replaced; every other member is the real client's. */
function withTransaction(run: (fn: TransactionFn) => Promise<unknown>): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return (fn: TransactionFn) => run(fn);
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/** `tx` with its raw queries recorded, in order, into `into`. */
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
