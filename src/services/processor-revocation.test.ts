import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { createPrismaClient } from '@/lib/prisma-client';
import { MollieUnavailable, type MollieClient } from '@/lib/mollie/client';
import { MOLLIE_SCOPES } from '@/lib/processor-liveness';
import { openToken } from '@/lib/processor-token-cipher';
import { logDegraded } from '@/lib/degradation';
import { scopeSweep } from '../../tests/scoped-sweep';
import { uniqueSuffix } from '../../tests/helpers';
import type { MollieDeps } from './mollie-deps';
import { sealGrant } from './processor-token';
import { RevocationFailedError, revokeDueConnections } from './processor-revocation';

const prisma = createPrismaClient();
const key = randomBytes(32);
const now = new Date();
const later = (ms: number) => new Date(now.getTime() + ms);

type Fake = { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const fake: Fake = {
  authorizeUrl: vi.fn(),
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  organization: vi.fn(),
  profiles: vi.fn(),
  listMethods: vi.fn(),
  createPayment: vi.fn(),
  getPayment: vi.fn(),
  createRefund: vi.fn(),
};
const deps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'app_client', clientSecret: 'secret', tokenKey: key, testmode: false, appUrl: 'https://fair.yoga' },
};

const teacherIds: string[] = [];
const accountIds: string[] = [];

async function freshTeacher(): Promise<string> {
  const s = uniqueSuffix();
  const email = `proc-revoke-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Re', lastName: 'Voke', email, bio: '', pageSlug: `proc-revoke-${s}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return t.id;
}

type Seed = { refresh?: string; sealKey?: Buffer; disconnected?: boolean; revokeAfter?: Date | null; revoked?: boolean };

/** One connection for a fresh teacher: disconnected and due by default, holding sealed tokens. */
async function seed(opts: Seed = {}): Promise<{ id: string; teacherId: string }> {
  const teacherId = await freshTeacher();
  const disconnected = opts.disconnected ?? true;
  const base = {
    teacherId, processor: 'mollie' as const, organizationId: 'org_aaaa1111', profileId: 'pfl_one11111', scopes: [...MOLLIE_SCOPES], testmode: false,
  };
  const row = await prisma.processorConnection.create({
    data: opts.revoked === true
      ? { ...base, disconnectedAt: later(-60_000), revokeAfter: later(-30_000), revokedAt: later(-1_000) }
      : {
          ...base,
          ...sealGrant({ accessToken: 'access_old', refreshToken: opts.refresh ?? 'refresh_old', expiresInSeconds: 3600, scopes: [...MOLLIE_SCOPES] }, opts.sealKey ?? key, now),
          ...(disconnected ? { disconnectedAt: later(-60_000), revokeAfter: opts.revokeAfter === undefined ? now : opts.revokeAfter } : {}),
        },
    select: { id: true },
  });
  return { id: row.id, teacherId };
}

function scoped(...rows: { id: string }[]) {
  return scopeSweep(prisma, { ProcessorConnection: { id: { in: rows.map((r) => r.id) } } });
}

const rowOf = (id: string) => prisma.processorConnection.findUniqueOrThrow({ where: { id } });

beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockReset();
  vi.mocked(logDegraded).mockClear();
});

afterAll(async () => {
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('revokeDueConnections', () => {
  it('revokes a due disconnected row: Mollie gets its refresh token, then the row is nulled and stamped', async () => {
    const due = await seed({ refresh: 'refresh_due' });
    fake.revoke.mockResolvedValue(undefined);
    const s = scoped(due);
    expect(await revokeDueConnections(s.db, now, deps)).toEqual({ revoked: 1, failed: 0, skipped: 0 });
    expect(s.rowsRead('ProcessorConnection')).toBeGreaterThan(0);
    expect(fake.revoke).toHaveBeenCalledTimes(1);
    expect(fake.revoke).toHaveBeenCalledWith('refresh_due');
    expect(await rowOf(due.id)).toMatchObject({ accessToken: null, refreshToken: null, accessTokenExpiresAt: null, revokedAt: now });
  });

  it('leaves a row whose window has not passed, a live row and an already-revoked row alone', async () => {
    const notDue = await seed({ revokeAfter: later(60_000) });
    const live = await seed({ disconnected: false });
    const done = await seed({ revoked: true });
    const s = scoped(notDue, live, done);
    expect(await revokeDueConnections(s.db, now, deps)).toEqual({ revoked: 0, failed: 0, skipped: 0 });
    expect(fake.revoke).not.toHaveBeenCalled();
    expect(openToken((await rowOf(notDue.id)).refreshToken!, key)).toBe('refresh_old');
    expect(openToken((await rowOf(live.id)).refreshToken!, key)).toBe('refresh_old');
    expect((await rowOf(done.id)).revokedAt).toEqual(later(-1_000));
  });

  it('counts a Mollie failure as failed and leaves that row due, while the others are still revoked', async () => {
    const bad = await seed({ refresh: 'refresh_bad' });
    const good = await seed({ refresh: 'refresh_good' });
    fake.revoke.mockImplementation(async (token: string) => {
      if (token === 'refresh_bad') throw new MollieUnavailable('down', 503);
    });
    expect(await revokeDueConnections(scoped(bad, good).db, now, deps)).toEqual({ revoked: 1, failed: 1, skipped: 0 });
    const badRow = await rowOf(bad.id);
    expect(badRow.revokedAt).toBeNull();
    expect(openToken(badRow.refreshToken!, key)).toBe('refresh_bad');
    expect((await rowOf(good.id)).revokedAt).toEqual(now);
  });

  it('counts a row whose token cannot be opened as failed and says so', async () => {
    const unreadable = await seed({ sealKey: randomBytes(32) });
    await expect(revokeDueConnections(scoped(unreadable).db, now, deps)).rejects.toBeInstanceOf(RevocationFailedError);
    expect(fake.revoke).not.toHaveBeenCalled();
    expect(vi.mocked(logDegraded).mock.calls.map(([code]) => code)).toContain('PROCESSOR_TOKEN_UNREADABLE');
    expect((await rowOf(unreadable.id)).revokedAt).toBeNull();
  });

  it('throws, carrying the report, when every due row failed, so the job reports the failure', async () => {
    const a = await seed({ refresh: 'refresh_a' });
    const b = await seed({ refresh: 'refresh_b' });
    fake.revoke.mockRejectedValue(new MollieUnavailable('down', 503));
    const err: unknown = await revokeDueConnections(scoped(a, b).db, now, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevocationFailedError);
    expect((err as RevocationFailedError).report).toEqual({ revoked: 0, failed: 2, skipped: 0 });
    expect((err as RevocationFailedError).message).toContain('every one failed');
    expect((await rowOf(a.id)).revokedAt).toBeNull();
  });

  it('counts an unexpected error on one row as failed and carries on with the next', async () => {
    const boom = await seed({ refresh: 'refresh_boom' });
    const fine = await seed({ refresh: 'refresh_fine' });
    fake.revoke.mockImplementation(async (token: string) => {
      if (token === 'refresh_boom') throw new Error('socket hang up');
    });
    expect(await revokeDueConnections(scoped(boom, fine).db, now, deps)).toEqual({ revoked: 1, failed: 1, skipped: 0 });
    expect((await rowOf(boom.id)).revokedAt).toBeNull();
    expect((await rowOf(fine.id)).revokedAt).toEqual(now);
  });

  it('skips every due row and writes nothing when Mollie is not configured', async () => {
    const a = await seed();
    const b = await seed();
    const notDue = await seed({ revokeAfter: later(60_000) });
    expect(await revokeDueConnections(scoped(a, b, notDue).db, now, null)).toEqual({ revoked: 0, failed: 0, skipped: 2 });
    expect(fake.revoke).not.toHaveBeenCalled();
    for (const r of [a, b]) expect(openToken((await rowOf(r.id)).refreshToken!, key)).toBe('refresh_old');
  });

  it('treats a revoke Mollie already considers done as a plain success (RFC 7009 answers 200)', async () => {
    const stale = await seed({ refresh: 'refresh_stale' });
    fake.revoke.mockResolvedValue(undefined);
    expect(await revokeDueConnections(scoped(stale).db, now, deps)).toEqual({ revoked: 1, failed: 0, skipped: 0 });
    expect((await rowOf(stale.id)).revokedAt).toEqual(now);
  });

  it('keeps the new grant of a reconnect that lands while the sweep is revoking, and counts the row skipped', async () => {
    const racing = await seed({ refresh: 'refresh_old' });
    fake.revoke.mockImplementation(async () => {
      await prisma.processorConnection.update({
        where: { id: racing.id },
        data: {
          ...sealGrant({ accessToken: 'access_new', refreshToken: 'refresh_new', expiresInSeconds: 3600, scopes: [...MOLLIE_SCOPES] }, key, now),
          disconnectedAt: null, revokeAfter: null, revokedAt: null,
        },
      });
    });
    expect(await revokeDueConnections(scoped(racing).db, now, deps)).toEqual({ revoked: 0, failed: 0, skipped: 1 });
    const row = await rowOf(racing.id);
    expect(row).toMatchObject({ disconnectedAt: null, revokedAt: null });
    expect(openToken(row.refreshToken!, key)).toBe('refresh_new');
  });
});
