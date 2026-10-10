/**
 * The pause's passkey delete is issued before its sessions' delete. A passkey
 * sign-in inserting a `Session` between the two would otherwise survive the
 * pause (the passkey delete only nulls its credential), and only the
 * statement order closes that window, so it is asserted from the delete calls
 * the pause makes on its transaction client, in the order it makes them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { pausePayments } from './payout-pause';
import { uniqueSuffix, seedSession } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

/**
 * A client whose transaction records each `deleteMany` as `model.deleteMany`.
 * Properties starting `$` or `_` are the client's own, not model delegates,
 * and pass through unwrapped: the pause's raw lock query reads `_extensions`,
 * which a proxy may not replace.
 */
function recordingClient(calls: string[]): PrismaClient {
  const record = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || prop.startsWith('$') || prop.startsWith('_')) return value;
        if (typeof value !== 'object' || value === null) return value;
        return new Proxy(value, {
          get(model, method, modelReceiver): unknown {
            const fn: unknown = Reflect.get(model, method, modelReceiver);
            if (method !== 'deleteMany' || typeof fn !== 'function') return fn;
            return (...args: unknown[]): unknown => {
              calls.push(`${prop}.deleteMany`);
              return Reflect.apply(fn, model, args);
            };
          },
        });
      },
    });
  return {
    $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      prisma.$transaction((tx) => fn(record(tx))),
  } as unknown as PrismaClient;
}

describe('pausePayments statement order', () => {
  it('deletes the recent passkeys before the sessions', async () => {
    const s = uniqueSuffix();
    const email = `pause-order-${s}@test.local`;
    const t = await prisma.teacher.create({
      data: { firstName: 'Pause', lastName: 'Order', email, bio: '', pageSlug: `pause-order-${s}`, account: { create: { email } } },
      select: { id: true, accountId: true },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    const now = new Date();
    const ev = await prisma.payoutChangeEvent.create({
      data: { teacherId: t.id, kind: 'bank_account_added', accountCurrency: 'EUR', after: '•••• 1234', createdAt: now },
      select: { id: true },
    });
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.payoutPauseToken.create({
      data: { tokenHash: hashToken(raw), teacherId: t.id, eventId: ev.id, expiresAt: new Date(now.getTime() + DAY_MS) },
    });
    // Created now, so it is past the cutoff and the pause deletes it.
    await prisma.passkeyCredential.create({
      data: { id: `pause-order-pk-${s}`, accountId: t.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt: now },
    });
    await seedSession(prisma, t.accountId);

    const calls: string[] = [];
    expect(await pausePayments(recordingClient(calls), raw, now)).toEqual({ status: 'paused' });

    const passkeyAt = calls.indexOf('passkeyCredential.deleteMany');
    const sessionAt = calls.indexOf('session.deleteMany');
    expect(passkeyAt).toBeGreaterThanOrEqual(0);
    expect(sessionAt).toBeGreaterThanOrEqual(0);
    expect(passkeyAt).toBeLessThan(sessionAt);
    expect(await prisma.passkeyCredential.count({ where: { accountId: t.accountId } })).toBe(0);
    expect(await prisma.session.count({ where: { accountId: t.accountId } })).toBe(0);
  });
});
