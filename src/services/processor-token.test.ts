import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import type { PrismaClient } from '@/lib/prisma-client';
import { MollieUnavailable, type MollieClient } from '@/lib/mollie/client';
import { openToken, sealToken } from '@/lib/processor-token-cipher';
import { uniqueSuffix } from '../../tests/helpers';
import { getAccessToken, sealGrant } from './processor-token';
import type { MollieDeps } from './mollie-deps';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const key = randomBytes(32);
const now = new Date('2026-10-18T12:00:00.000Z');

const fake = {
  authorizeUrl: vi.fn(),
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
} as unknown as { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const deps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'client', clientSecret: 'secret', tokenKey: key, testmode: true, appUrl: 'https://fair.yoga' },
};

let teacherId = '';
let accountId = '';

function degradations(): { code: string }[] {
  return vi.mocked(logDegraded).mock.calls.map(([code]) => ({ code }));
}

async function seedConnection(opts: { expiresAt?: Date; sealWith?: Buffer; revoked?: boolean; disconnectedAt?: Date }) {
  await prisma.processorConnection.deleteMany({ where: { teacherId } });
  const sealKey = opts.sealWith ?? key;
  return prisma.processorConnection.create({
    data: opts.revoked
      ? { teacherId, processor: 'mollie', organizationId: 'org_test', scopes: [], testmode: true, disconnectedAt: now, revokedAt: now }
      : {
          teacherId,
          processor: 'mollie',
          organizationId: 'org_test',
          profileId: 'pfl_test',
          accessToken: new Uint8Array(sealToken('access_plain', sealKey)),
          refreshToken: new Uint8Array(sealToken('refresh_plain', sealKey)),
          accessTokenExpiresAt: opts.expiresAt,
          disconnectedAt: opts.disconnectedAt,
          scopes: [],
          testmode: true,
        },
  });
}

beforeAll(async () => {
  const email = `proc-token-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: { firstName: 'Tok', lastName: 'En', email, bio: '', pageSlug: `proc-token-${suffix}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
});

beforeEach(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: teacherId } });
  vi.clearAllMocks();
  fake.refresh.mockReset();
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('getAccessToken', () => {
  it('answers the stored token while it has more than five minutes left', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() + 10 * 60_000) });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'access_plain' });
    expect(fake.refresh).not.toHaveBeenCalled();
  });
  it('refreshes inside the margin and stores the new pair sealed', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() + 60_000) });
    fake.refresh.mockResolvedValue({ kind: 'granted', grant: { accessToken: 'access_new', refreshToken: 'refresh_new', expiresInSeconds: 3600, scopes: [] } });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'access_new' });
    const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(openToken(row.refreshToken!, key)).toBe('refresh_new');
    expect(row.accessTokenExpiresAt!.getTime()).toBe(now.getTime() + 3_600_000);
  });
  it('refreshes once for concurrent callers', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
    fake.refresh.mockImplementation(async () => ({ kind: 'granted', grant: { accessToken: 'a2', refreshToken: 'r2', expiresInSeconds: 3600, scopes: [] } }));
    const results = await Promise.all([getAccessToken(prisma, deps, c.id, now), getAccessToken(prisma, deps, c.id, now)]);
    expect(fake.refresh).toHaveBeenCalledTimes(1);
    expect(results).toEqual([{ kind: 'token', accessToken: 'a2' }, { kind: 'token', accessToken: 'a2' }]);
  });
  it('disconnects, nulls the tokens, tells the teacher and logs on invalid_grant', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
    fake.refresh.mockResolvedValue({ kind: 'invalid_grant' });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'disconnected' });
    const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({ accessToken: null, refreshToken: null, disconnectedAt: now, revokedAt: now });
    expect(await prisma.notification.count({ where: { recipientId: teacherId, type: 'processor_disconnected' } })).toBe(1);
    expect(degradations().map((d) => d.code)).toContain('PROCESSOR_DISCONNECTED');
  });
  it('answers unavailable and leaves the connection alone when Mollie is down', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
    fake.refresh.mockRejectedValue(new MollieUnavailable('down', 503));
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'unavailable' });
    expect((await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } })).disconnectedAt).toBeNull();
    expect(degradations().map((d) => d.code)).toContain('MOLLIE_UNAVAILABLE');
  });
  it('answers unavailable without disconnecting when the stored token cannot be opened (Review Focus 3)', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() + 3_600_000), sealWith: randomBytes(32) });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'unavailable' });
    expect((await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } })).disconnectedAt).toBeNull();
    expect(degradations().map((d) => d.code)).toContain('PROCESSOR_TOKEN_UNREADABLE');
  });
  it('answers disconnected for a revoked row', async () => {
    const c = await seedConnection({ revoked: true });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'disconnected' });
  });
  it("uses the winner's token when another refresh wrote first", async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
    fake.refresh.mockImplementation(async () => {
      await prisma.processorConnection.update({
        where: { id: c.id },
        data: sealGrant({ accessToken: 'winner', refreshToken: 'rw', expiresInSeconds: 3600, scopes: [] }, key, now),
      });
      return { kind: 'granted', grant: { accessToken: 'loser', refreshToken: 'rl', expiresInSeconds: 3600, scopes: [] } };
    });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'winner' });
  });

  it('answers a token for a disconnected row that is not yet revoked', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() + 3_600_000), disconnectedAt: new Date(now.getTime() - 1000) });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'access_plain' });
  });
  it('answers disconnected for a missing row', async () => {
    expect(await getAccessToken(prisma, deps, '00000000-0000-4000-8000-000000000000', now)).toEqual({ kind: 'disconnected' });
  });
  it('does not disconnect when a peer replaced the grant before invalid_grant arrived', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
    fake.refresh.mockImplementation(async () => {
      await prisma.processorConnection.update({
        where: { id: c.id },
        data: sealGrant({ accessToken: 'winner', refreshToken: 'rw', expiresInSeconds: 3600, scopes: [] }, key, now),
      });
      return { kind: 'invalid_grant' };
    });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'winner' });
    const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.revokedAt).toBeNull();
    expect(await prisma.notification.count({ where: { recipientId: teacherId, type: 'processor_disconnected' } })).toBe(0);
    expect(degradations().map((d) => d.code)).not.toContain('PROCESSOR_DISCONNECTED');
  });
  it('keeps an existing disconnectedAt and tells the teacher nothing new on invalid_grant', async () => {
    const earlier = new Date(now.getTime() - 86_400_000);
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1), disconnectedAt: earlier });
    fake.refresh.mockResolvedValue({ kind: 'invalid_grant' });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'disconnected' });
    const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({ accessToken: null, refreshToken: null, disconnectedAt: earlier, revokedAt: now });
    expect(await prisma.notification.count({ where: { recipientId: teacherId, type: 'processor_disconnected' } })).toBe(0);
  });
  it('does not start a second refresh for a caller whose read predates the first flight', async () => {
    const c = await seedConnection({ expiresAt: new Date(now.getTime() - 1) });
    const stale = await prisma.processorConnection.findUniqueOrThrow({ where: { id: c.id } });
    fake.refresh.mockResolvedValue({ kind: 'granted', grant: { accessToken: 'a2', refreshToken: 'r2', expiresInSeconds: 3600, scopes: [] } });
    expect(await getAccessToken(prisma, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'a2' });
    let first = true;
    const lagging = {
      processorConnection: {
        findUnique: (args: Parameters<typeof prisma.processorConnection.findUnique>[0]) => {
          if (first) {
            first = false;
            return Promise.resolve(stale);
          }
          return prisma.processorConnection.findUnique(args);
        },
        updateMany: prisma.processorConnection.updateMany.bind(prisma.processorConnection),
      },
    } as unknown as PrismaClient;
    expect(await getAccessToken(lagging, deps, c.id, now)).toEqual({ kind: 'token', accessToken: 'a2' });
    expect(fake.refresh).toHaveBeenCalledTimes(1);
  });
});
