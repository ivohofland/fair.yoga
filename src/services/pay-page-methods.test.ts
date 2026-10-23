import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient, Prisma } from '@/lib/prisma-client';
import { MollieUnavailable, type MollieClient } from '@/lib/mollie/client';
import { MOLLIE_SCOPES } from '@/lib/processor-liveness';
import { paymentMethodsForTeacher } from '@/lib/payment-methods';
import { sealToken } from '@/lib/processor-token-cipher';
import { uniqueSuffix } from '../../tests/helpers';
import type { MollieDeps } from './mollie-deps';
import { forgetOfferedMethods } from './processor-methods-cache';
import { payPageMethods, payPageTeacherSelect } from './pay-page-methods';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const key = randomBytes(32);
const AMOUNT = new Prisma.Decimal('12.50');

const fake = { refresh: vi.fn(), listMethods: vi.fn() } as unknown as { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const deps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'client', clientSecret: 'secret', tokenKey: key, testmode: true, appUrl: 'https://fair.yoga' },
};

let teacherId = '';
let accountId = '';
let connectionId = '';

async function seedConnection(
  overrides: Partial<{ profileId: string | null; disconnectedAt: Date | null; revokeAfter: Date | null; scopes: string[]; testmode: boolean }> = {},
) {
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
  const row = await prisma.processorConnection.create({
    data: {
      teacherId,
      processor: 'mollie',
      organizationId: 'org_paypage',
      profileId: 'pfl_paypage',
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

async function teacher() {
  return prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: payPageTeacherSelect });
}

beforeAll(async () => {
  const email = `pay-page-methods-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Pay', lastName: 'Page', email, bio: '', pageSlug: `pay-page-methods-${suffix}`,
      paymentLink: 'https://revolut.me/paypage',
      bankAccounts: { create: [{ currency: 'EUR', holderName: 'P. Page', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' }] },
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  teacherId = t.id;
  accountId = t.accountId;
});

beforeEach(async () => {
  vi.clearAllMocks();
  fake.listMethods.mockReset();
  if (connectionId !== '') forgetOfferedMethods(connectionId);
  await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: null } });
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
});

afterAll(async () => {
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
  await prisma.teacherBankAccount.deleteMany({ where: { teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('payPageMethods', () => {
  it('answers exactly the manual-payment methods without a connection', async () => {
    const t = await teacher();
    const answer = await payPageMethods(prisma, deps, t, 'EUR', AMOUNT);
    expect(answer).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    expect(answer.kind === 'methods' && answer.methods.length).toBe(3);
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('answers the manual-payment methods when Mollie is not configured, even with a live connection', async () => {
    await seedConnection();
    const t = await teacher();
    expect(await payPageMethods(prisma, null, t, 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('puts the offered Mollie methods first, in allowlist order, before the manual-payment methods', async () => {
    await seedConnection();
    fake.listMethods.mockResolvedValue({ kind: 'methods', methods: ['twint', 'ideal'].map((id) => ({ id, description: null })) });
    const t = await teacher();
    const manual = paymentMethodsForTeacher(t, 'EUR');
    if (manual.kind !== 'methods') throw new Error('expected methods');
    expect(await payPageMethods(prisma, deps, t, 'EUR', AMOUNT)).toEqual({
      kind: 'methods',
      methods: [{ kind: 'processor', method: 'ideal' }, { kind: 'processor', method: 'twint' }, ...manual.methods],
    });
    expect(fake.listMethods).toHaveBeenCalledWith('access_plain', {
      profileId: 'pfl_paypage',
      amount: { value: '12.50', currency: 'EUR' },
      testmode: true,
    });
  });

  it('answers the manual-payment methods unchanged when Mollie is unavailable', async () => {
    await seedConnection();
    fake.listMethods.mockRejectedValue(new MollieUnavailable('down', 503));
    const t = await teacher();
    expect(await payPageMethods(prisma, deps, t, 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
  });

  it('answers paused for a paused teacher, without asking Mollie', async () => {
    await seedConnection();
    await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: new Date() } });
    expect(await payPageMethods(prisma, deps, await teacher(), 'EUR', AMOUNT)).toEqual({ kind: 'paused' });
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('asks Mollie nothing for a disconnected connection that still holds its tokens', async () => {
    const at = new Date();
    await seedConnection({ disconnectedAt: at, revokeAfter: at });
    const t = await teacher();
    expect(await payPageMethods(prisma, deps, t, 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('asks Mollie nothing for a connection without a profile', async () => {
    await seedConnection({ profileId: null });
    const t = await teacher();
    expect(await payPageMethods(prisma, deps, t, 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('asks Mollie nothing for a connection made in the other mode than the server now runs in', async () => {
    await seedConnection({ testmode: false });
    const t = await teacher();
    expect(await payPageMethods(prisma, deps, t, 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    await seedConnection({ testmode: true });
    const live = { ...deps, config: { ...deps.config, testmode: false } };
    expect(await payPageMethods(prisma, live, await teacher(), 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    expect(fake.listMethods).not.toHaveBeenCalled();
  });

  it('asks Mollie nothing for a connection whose grant lacks a requested scope', async () => {
    await seedConnection({ scopes: MOLLIE_SCOPES.filter((s) => s !== 'payments.write') });
    const t = await teacher();
    expect(await payPageMethods(prisma, deps, t, 'EUR', AMOUNT)).toEqual(paymentMethodsForTeacher(t, 'EUR'));
    expect(fake.listMethods).not.toHaveBeenCalled();
  });
});
