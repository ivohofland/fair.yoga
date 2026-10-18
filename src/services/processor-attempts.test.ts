import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient, Prisma } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import { hhmmToTime } from '@/lib/time-of-day';
import { MollieUnavailable, type CreatePaymentInput, type MollieClient, type MolliePaymentView } from '@/lib/mollie/client';
import { MOLLIE_SCOPES } from '@/lib/processor-liveness';
import { paymentReference } from '@/lib/payment-methods';
import { sealToken } from '@/lib/processor-token-cipher';
import { uniqueSuffix } from '../../tests/helpers';
import { createClassFixture } from '../../tests/class-fixtures';
import type { MollieDeps } from './mollie-deps';
import { forgetOfferedMethods } from './processor-methods-offer';
import { createAttempt, processorReturnUrl, processorWebhookUrl, type CreateAttemptOutcome } from './processor-attempts';

const prisma = createPrismaClient();
const key = randomBytes(32);
const MINUTE = 60_000;

type Fake = { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const fake = { refresh: vi.fn(), listMethods: vi.fn(), createPayment: vi.fn() } as unknown as Fake;
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

async function seedConnection(overrides: Partial<{ disconnectedAt: Date | null; revokeAfter: Date | null; scopes: string[] }> = {}) {
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

async function seedAttempt(paymentId: string, method: string, expiresAt: Date, status: 'open' | 'paid' = 'open') {
  return prisma.processorPayment.create({
    data: {
      paymentId, connectionId, processorPaymentId: `tr_${uniqueSuffix().replace(/-/g, '')}`, method, status,
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
  fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['ideal', 'creditcard', 'klarna'] });
  fake.createPayment.mockImplementation(async () => molliePayment());
});

afterAll(async () => {
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
      paymentId, connectionId, method: 'ideal', status: 'open', currency: 'EUR',
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

    it('a method off the allowlist with PROCESSOR_METHOD_UNAVAILABLE', async () => {
      const { paymentId } = await freshPayment();
      expect(refusalCode(await createAttempt(prisma, deps, { paymentId, studentId, method: 'klarna' }))).toBe('PROCESSOR_METHOD_UNAVAILABLE');
      expect(fake.createPayment).not.toHaveBeenCalled();
    });

    it('an allowlisted method the teacher does not offer for this payment with PROCESSOR_METHOD_UNAVAILABLE', async () => {
      const { paymentId } = await freshPayment();
      fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['creditcard'] });
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
    it('records the attempt on a connection disconnected meanwhile and keeps its token past the attempt', async () => {
      const { paymentId } = await freshPayment();
      fake.createPayment.mockImplementation(async () => {
        const at = new Date();
        await prisma.processorConnection.update({ where: { id: connectionId }, data: { disconnectedAt: at, revokeAfter: at } });
        return molliePayment();
      });

      const outcome = await createAttempt(prisma, deps, { paymentId, studentId, method: 'ideal' });

      if (outcome.kind !== 'checkout') throw new Error(`expected checkout, got ${JSON.stringify(outcome)}`);
      const attempt = await prisma.processorPayment.findUniqueOrThrow({ where: { id: outcome.attemptId } });
      const conn = await prisma.processorConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(attempt.expiresAt).not.toBeNull();
      expect(conn.revokeAfter!.getTime()).toBeGreaterThanOrEqual(attempt.expiresAt!.getTime());
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
  it('omits the webhook on a host Mollie cannot reach', () => {
    expect(processorWebhookUrl('http://localhost:3000')).toBeNull();
    expect(processorWebhookUrl('http://127.0.0.1:3164')).toBeNull();
    expect(processorWebhookUrl('https://fair.yoga')).toBe('https://fair.yoga/api/webhooks/mollie');
  });
});
