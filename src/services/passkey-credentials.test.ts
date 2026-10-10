import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { deletePasskey, lockForPasskeyRemoval, removePasskeyLocked } from './passkey-credentials';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const accountIds: string[] = [];
const teacherIds: string[] = [];

async function makeAccount(opts: { pausedAt?: Date } = {}): Promise<string> {
  const s = uniqueSuffix();
  const email = `pk-del-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Pk', lastName: 'Del', email, bio: '', pageSlug: `pk-del-${s}`,
      account: { create: { email } },
      paymentsPausedAt: opts.pausedAt ?? null,
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return t.accountId;
}

async function passkey(accountId: string, createdAt: Date): Promise<string> {
  const id = `pk-del-${uniqueSuffix()}`;
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
  return id;
}

afterAll(async () => {
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('deletePasskey', () => {
  it('removes the passkey and records when the removed credential was created', async () => {
    const accountId = await makeAccount();
    const createdAt = new Date('2026-01-02T03:04:05Z');
    const id = await passkey(accountId, createdAt);

    const outcome = await deletePasskey(prisma, { accountId, credentialId: id });

    expect(outcome.status).toBe('deleted');
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(0);
    const removed = await prisma.removedPasskey.findMany({ where: { accountId } });
    expect(removed).toHaveLength(1);
    expect(removed[0]?.credentialCreatedAt).toEqual(createdAt);
    expect(outcome).toEqual({ status: 'deleted', removedAt: removed[0]?.removedAt });
  });

  it('records nothing for a passkey of another account', async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount();
    const id = await passkey(theirs, new Date('2026-01-02T03:04:05Z'));

    expect(await deletePasskey(prisma, { accountId: mine, credentialId: id })).toEqual({ status: 'not_found' });

    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
    expect(await prisma.removedPasskey.count({ where: { accountId: { in: [mine, theirs] } } })).toBe(0);
  });

  it('refuses while payments are paused and records nothing', async () => {
    const accountId = await makeAccount({ pausedAt: new Date() });
    const id = await passkey(accountId, new Date('2026-01-02T03:04:05Z'));

    expect(await deletePasskey(prisma, { accountId, credentialId: id })).toEqual({ status: 'payments_paused' });

    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(0);
  });

  it('removes a passkey of an account with no teacher profile', async () => {
    const account = await prisma.account.create({ data: { email: `pk-del-solo-${uniqueSuffix()}@test.local` }, select: { id: true } });
    accountIds.push(account.id);
    const id = await passkey(account.id, new Date('2026-01-02T03:04:05Z'));

    expect((await deletePasskey(prisma, { accountId: account.id, credentialId: id })).status).toBe('deleted');
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(0);
  });
});

describe('lockForPasskeyRemoval and removePasskeyLocked', () => {
  it('lockForPasskeyRemoval reports a paused account as paused and removes nothing itself', async () => {
    const accountId = await makeAccount({ pausedAt: new Date() });
    const id = await passkey(accountId, new Date('2026-01-02T03:04:05Z'));

    const paused = await prisma.$transaction(async (tx) => (await lockForPasskeyRemoval(tx, accountId)).paused);

    expect(paused).toBe(true);
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
  });

  it('reports not paused for an account with no teacher profile, and removes with a record', async () => {
    const account = await prisma.account.create({ data: { email: `pk-lock-${uniqueSuffix()}@test.local` }, select: { id: true } });
    accountIds.push(account.id);
    const id = await passkey(account.id, new Date('2026-01-02T03:04:05Z'));

    const out = await prisma.$transaction(async (tx) => {
      expect((await lockForPasskeyRemoval(tx, account.id)).paused).toBe(false);
      return removePasskeyLocked(tx, { accountId: account.id, credentialId: id });
    });

    expect(out.status).toBe('deleted');
    expect(await prisma.removedPasskey.count({ where: { accountId: account.id } })).toBe(1);
  });

  it('answers not_found for a credential of another account', async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount();
    const id = await passkey(theirs, new Date('2026-01-02T03:04:05Z'));

    const out = await prisma.$transaction((tx) => removePasskeyLocked(tx, { accountId: mine, credentialId: id }));

    expect(out).toEqual({ status: 'not_found' });
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
  });
});
