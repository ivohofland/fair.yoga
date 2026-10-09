import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';
import { grantAdmin, revokeAdmin, listAdmins } from './admin-grants';

const db = new PrismaClient();
const suffix = uniqueSuffix();
const emailOf = (label: string) => `admin-grants-${label}-${suffix}@test.local`;
const accountIds: string[] = [];

async function studentAccount(label: string, opts: { passkey: boolean }): Promise<string> {
  const email = emailOf(label);
  const student = await db.student.create({
    data: {
      firstName: 'Admin',
      lastName: label,
      email,
      account: { create: { email } },
      claimedAt: new Date(),
      incomeTier: 3,
    },
    select: { accountId: true },
  });
  const accountId = student.accountId!;
  accountIds.push(accountId);
  if (opts.passkey) {
    await db.passkeyCredential.create({
      data: { id: `cred-${label}-${suffix}`, accountId, publicKey: Buffer.from([1]), counter: 0, transports: [] },
    });
  }
  return accountId;
}

afterAll(async () => {
  if (accountIds.length > 0) {
    await db.adminGrant.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.student.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await db.$disconnect();
});

describe('grantAdmin', () => {
  let accountId: string;
  beforeAll(async () => {
    accountId = await studentAccount('grant', { passkey: true });
  });

  it('grants an account that holds a passkey', async () => {
    expect(await grantAdmin(db, { email: emailOf('grant'), by: 'tester' })).toEqual({ kind: 'granted' });
    const rows = await db.adminGrant.findMany({ where: { accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantedBy: 'tester', revokedAt: null });
  });

  it('answers unchanged for an account already granted, writing nothing', async () => {
    expect(await grantAdmin(db, { email: emailOf('grant'), by: 'tester' })).toEqual({ kind: 'unchanged' });
    expect(await db.adminGrant.count({ where: { accountId } })).toBe(1);
  });

  it('matches the address case-insensitively and trimmed', async () => {
    expect(await grantAdmin(db, { email: `  ${emailOf('grant').toUpperCase()} `, by: 'tester' })).toEqual({
      kind: 'unchanged',
    });
  });

  it('collapses concurrent grants into one active row', async () => {
    const racer = await studentAccount('race', { passkey: true });
    const outcomes = await Promise.all([
      grantAdmin(db, { email: emailOf('race'), by: 'a' }),
      grantAdmin(db, { email: emailOf('race'), by: 'b' }),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['granted', 'unchanged']);
    expect(await db.adminGrant.count({ where: { accountId: racer, revokedAt: null } })).toBe(1);
  });

  it('refuses an address with no account', async () => {
    expect(await grantAdmin(db, { email: emailOf('nobody'), by: 'tester' })).toEqual({
      kind: 'refused',
      reason: 'no_account',
    });
  });

  it('refuses an account without a passkey', async () => {
    await studentAccount('nopasskey', { passkey: false });
    expect(await grantAdmin(db, { email: emailOf('nopasskey'), by: 'tester' })).toEqual({
      kind: 'refused',
      reason: 'no_passkey',
    });
  });

  it('refuses an empty operator name', async () => {
    expect(await grantAdmin(db, { email: emailOf('grant'), by: '  ' })).toEqual({
      kind: 'refused',
      reason: 'no_operator',
    });
  });
});

describe('revokeAdmin', () => {
  let accountId: string;
  beforeAll(async () => {
    accountId = await studentAccount('revoke', { passkey: true });
    await grantAdmin(db, { email: emailOf('revoke'), by: 'tester' });
  });

  it('stamps the active grant', async () => {
    expect(await revokeAdmin(db, { email: emailOf('revoke'), by: 'remover' })).toEqual({ kind: 'revoked' });
    const row = await db.adminGrant.findFirstOrThrow({ where: { accountId } });
    expect(row.revokedBy).toBe('remover');
    expect(row.revokedAt).not.toBeNull();
  });

  it('answers unchanged when nothing is active', async () => {
    expect(await revokeAdmin(db, { email: emailOf('revoke'), by: 'remover' })).toEqual({ kind: 'unchanged' });
  });

  it('grant after revoke inserts a new row and keeps the old one', async () => {
    expect(await grantAdmin(db, { email: emailOf('revoke'), by: 'tester' })).toEqual({ kind: 'granted' });
    expect(await db.adminGrant.count({ where: { accountId } })).toBe(2);
  });
});

describe('listAdmins', () => {
  it('lists active grants and marks one dormant once its only profile is erased', async () => {
    const accountId = await studentAccount('dormant', { passkey: true });
    await grantAdmin(db, { email: emailOf('dormant'), by: 'tester' });

    const before = (await listAdmins(db)).find((a) => a.accountId === accountId);
    expect(before).toMatchObject({ email: emailOf('dormant'), grantedBy: 'tester', dormant: false });

    await db.student.updateMany({ where: { accountId }, data: { deletedAt: new Date() } });
    const after = (await listAdmins(db)).find((a) => a.accountId === accountId);
    expect(after?.dormant).toBe(true);
  });

  it('omits revoked grants', async () => {
    const accountId = await studentAccount('listrevoked', { passkey: true });
    await grantAdmin(db, { email: emailOf('listrevoked'), by: 'tester' });
    await revokeAdmin(db, { email: emailOf('listrevoked'), by: 'tester' });
    expect((await listAdmins(db)).some((a) => a.accountId === accountId)).toBe(false);
  });
});

describe('admin-grants.ts imports', () => {
  it('imports only @prisma/client, which is all the migrate image carries', () => {
    const source = readFileSync(path.join(__dirname, 'admin-grants.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.every((s) => s === '@prisma/client')).toBe(true);
  });
});
