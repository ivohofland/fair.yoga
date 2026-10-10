/**
 * The passkey's delete is issued before the sessions' delete. A passkey
 * sign-in inserting a `Session` between the two would otherwise survive the
 * redemption (the passkey delete only nulls its credential), and only the
 * statement order closes that window, so it is asserted from the delete calls
 * the redemption makes on its transaction client, in the order it makes them.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { mintPasskeyRevokeToken } from './passkey-revoke-token';
import { revokePasskeyByLink } from './passkey-revoke';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();

const accountIds: string[] = [];

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

/** A client whose transaction records each `deleteMany` as `model.deleteMany`. */
function recordingClient(calls: string[]): PrismaClient {
  const record = (tx: Prisma.TransactionClient): Prisma.TransactionClient =>
    new Proxy(tx, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string' || typeof value !== 'object' || value === null) return value;
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

describe('revokePasskeyByLink statement order', () => {
  it('deletes the passkey before the sessions', async () => {
    const s = uniqueSuffix();
    const account = await prisma.account.create({ data: { email: `revoke-order-${s}@test.local` }, select: { id: true } });
    accountIds.push(account.id);
    const credentialId = `revoke-order-pk-${s}`;
    await prisma.passkeyCredential.create({
      data: { id: credentialId, accountId: account.id, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });
    await prisma.session.create({
      data: { id: crypto.randomBytes(16).toString('hex'), accountId: account.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const raw = await mintPasskeyRevokeToken(prisma, { accountId: account.id, credentialId });

    const calls: string[] = [];
    const out = await revokePasskeyByLink(recordingClient(calls), raw);
    expect(out.status).toBe('revoked');

    const passkeyAt = calls.indexOf('passkeyCredential.deleteMany');
    const sessionAt = calls.indexOf('session.deleteMany');
    expect(passkeyAt).toBeGreaterThanOrEqual(0);
    expect(sessionAt).toBeGreaterThanOrEqual(0);
    expect(passkeyAt).toBeLessThan(sessionAt);
  });
});
