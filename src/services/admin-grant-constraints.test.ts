import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';

const db = new PrismaClient();
const suffix = uniqueSuffix();
let accountId: string;

beforeAll(async () => {
  accountId = (await db.account.create({ data: { email: `admin-grant-c-${suffix}@test.local` } })).id;
});

afterAll(async () => {
  if (accountId) {
    await db.adminGrant.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
  }
  await db.$disconnect();
});

function uniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

describe('AdminGrant constraints, inserted directly', () => {
  it('refuses a second active grant for one account', async () => {
    await db.adminGrant.create({ data: { accountId, grantedBy: 'test' } });
    const second = db.adminGrant.create({ data: { accountId, grantedBy: 'test' } });
    await expect(second).rejects.toSatisfy(uniqueViolation);
  });

  it('allows a new active grant once the earlier one is revoked', async () => {
    await db.adminGrant.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: 'test' },
    });
    await expect(db.adminGrant.create({ data: { accountId, grantedBy: 'test' } })).resolves.toBeDefined();
  });

  it('refuses revokedAt without revokedBy, and the reverse', async () => {
    const active = await db.adminGrant.findFirstOrThrow({ where: { accountId, revokedAt: null } });
    await expect(
      db.adminGrant.update({ where: { id: active.id }, data: { revokedAt: new Date() } }),
    ).rejects.toThrow(/AdminGrant_revoke_pair_check/);
    await expect(
      db.adminGrant.update({ where: { id: active.id }, data: { revokedBy: 'test' } }),
    ).rejects.toThrow(/AdminGrant_revoke_pair_check/);
  });

  it('refuses deleting an account that holds a grant (Restrict)', async () => {
    await expect(db.account.delete({ where: { id: accountId } })).rejects.toThrow();
  });
});
