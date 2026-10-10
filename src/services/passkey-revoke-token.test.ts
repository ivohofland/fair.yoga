import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { mintPasskeyRevokeToken, PASSKEY_REVOKE_TOKEN_TTL_DAYS } from './passkey-revoke-token';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('mintPasskeyRevokeToken', () => {
  it('returns a raw secret and stores only its hash, scoped to the account and credential', async () => {
    const account = await prisma.account.create({
      data: { email: `revoke-mint-${uniqueSuffix()}@test.local` },
      select: { id: true },
    });
    accountIds.push(account.id);

    const before = Date.now();
    const raw = await mintPasskeyRevokeToken(prisma, { accountId: account.id, credentialId: 'cred-1' });

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.passkeyRevokeToken.findUniqueOrThrow({ where: { tokenHash: hashToken(raw) } });
    expect(row).toMatchObject({ accountId: account.id, credentialId: 'cred-1' });
    expect(JSON.stringify(row)).not.toContain(raw);
    const ttlMs = PASSKEY_REVOKE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ttlMs);
  });
});
