import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient, Prisma } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import { MollieUnavailable, type MollieClient } from '@/lib/mollie/client';
import { sealToken } from '@/lib/processor-token-cipher';
import { uniqueSuffix } from '../../tests/helpers';
import type { MollieDeps } from './mollie-deps';
import { forgetOfferedMethods, listOfferedMethods } from './processor-methods-offer';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const key = randomBytes(32);

const fake = {
  refresh: vi.fn(),
  listMethods: vi.fn(),
} as unknown as { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const deps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'client', clientSecret: 'secret', tokenKey: key, testmode: true, appUrl: 'https://fair.yoga' },
};

let teacherId = '';
let accountId = '';
let conn = { id: '', profileId: 'pfl_test', testmode: true };

function degradations(): { code: string }[] {
  return vi.mocked(logDegraded).mock.calls.map(([code]) => ({ code }));
}

beforeAll(async () => {
  const email = `proc-offer-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: { firstName: 'Off', lastName: 'Er', email, bio: '', pageSlug: `proc-offer-${suffix}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  const row = await prisma.processorConnection.create({
    data: {
      teacherId,
      processor: 'mollie',
      organizationId: 'org_test',
      profileId: 'pfl_test',
      accessToken: new Uint8Array(sealToken('access_plain', key)),
      refreshToken: new Uint8Array(sealToken('refresh_plain', key)),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: [],
      testmode: true,
    },
  });
  conn = { id: row.id, profileId: 'pfl_test', testmode: true };
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.listMethods.mockReset();
  forgetOfferedMethods(conn.id);
});

afterAll(async () => {
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('listOfferedMethods', () => {
  it('offers allowlisted methods in allowlist order and reports the rest', async () => {
    fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['twint', 'klarna', 'ideal'] });
    expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('12.50'), 'EUR'))
      .toEqual({ kind: 'methods', offered: ['ideal', 'twint'], excluded: ['klarna'] });
    expect(fake.listMethods).toHaveBeenCalledWith('access_plain', { profileId: conn.profileId, amount: { value: '12.50', currency: 'EUR' }, testmode: true });
  });
  it('drops an id the processor returns that the allowlist does not hold', async () => {
    fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['brandnewcredit'] });
    expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR'))
      .toEqual({ kind: 'methods', offered: [], excluded: ['brandnewcredit'] });
  });
  it('answers empty for an unsupported currency, without a degradation', async () => {
    fake.listMethods.mockResolvedValue({ kind: 'unsupported' });
    expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'AED'))
      .toEqual({ kind: 'methods', offered: [], excluded: [] });
    expect(degradations()).toHaveLength(0);
  });
  it('answers empty for a zero amount without calling Mollie', async () => {
    expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('0.00'), 'EUR'))
      .toEqual({ kind: 'methods', offered: [], excluded: [] });
    expect(fake.listMethods).not.toHaveBeenCalled();
  });
  it('answers unavailable and logs MOLLIE_UNAVAILABLE when Mollie is down', async () => {
    fake.listMethods.mockRejectedValue(new MollieUnavailable('down', 503));
    expect(await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR')).toEqual({ kind: 'unavailable' });
    expect(degradations().map((d) => d.code)).toEqual(['MOLLIE_UNAVAILABLE']);
  });
  it('does not cache an unavailable answer', async () => {
    fake.listMethods.mockRejectedValueOnce(new MollieUnavailable('down', 503));
    fake.listMethods.mockResolvedValueOnce({ kind: 'methods', ids: ['ideal'] });
    const five = new Prisma.Decimal('5.00');
    expect(await listOfferedMethods(prisma, deps, conn, five, 'EUR', 1_000)).toEqual({ kind: 'unavailable' });
    expect(await listOfferedMethods(prisma, deps, conn, five, 'EUR', 1_001)).toEqual({ kind: 'methods', offered: ['ideal'], excluded: [] });
  });
  it('caches for 60 s per connection, currency and amount', async () => {
    fake.listMethods.mockResolvedValue({ kind: 'methods', ids: ['ideal'] });
    await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR', 1_000);
    await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR', 1_000 + 59_999);
    expect(fake.listMethods).toHaveBeenCalledTimes(1);
    await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('5.00'), 'EUR', 1_000 + 60_000);
    expect(fake.listMethods).toHaveBeenCalledTimes(2);
    await listOfferedMethods(prisma, deps, conn, new Prisma.Decimal('6.00'), 'EUR', 1_000 + 60_000);
    expect(fake.listMethods).toHaveBeenCalledTimes(3);
  });
});
