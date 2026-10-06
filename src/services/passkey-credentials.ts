import type { PrismaClient } from '@prisma/client';

/** What a person may see of one of their own passkeys — never key material. */
export interface PasskeySummary {
  id: string;
  createdAt: Date;
  transports: string[];
}

/** The account's passkeys, newest first. */
export async function listPasskeys(db: PrismaClient, accountId: string): Promise<PasskeySummary[]> {
  return db.passkeyCredential.findMany({
    where: { accountId },
    select: { id: true, createdAt: true, transports: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  });
}

/**
 * Remove one of the account's passkeys. The filter carries `accountId`, so a
 * credential of another account is indistinguishable from one that does not
 * exist: both answer `false`.
 */
export async function deletePasskey(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<boolean> {
  const { count } = await db.passkeyCredential.deleteMany({
    where: { id: input.credentialId, accountId: input.accountId },
  });
  return count > 0;
}
