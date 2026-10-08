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
 * `deleted` carries when the removal was recorded; `payments_paused`: the
 * account's teacher has payments paused.
 */
export type DeletePasskeyOutcome =
  | { status: 'deleted'; removedAt: Date }
  | { status: 'not_found' }
  | { status: 'payments_paused' };

/**
 * Remove one of the account's passkeys, and record the removal as a
 * `RemovedPasskey` in the same transaction, so a pause that reads after it
 * sees the passkey either standing or removed, never neither. The filter
 * carries `accountId`, so a credential of another account is
 * indistinguishable from one that does not exist: both answer `not_found`.
 *
 * Refused while the account's teacher has payments paused. Why a removal
 * before a pause, and one during it, cannot lift the passkey requirement:
 * `docs/technical-architecture.md`, "Resuming paused payments". An account
 * with no teacher profile is never paused.
 */
export async function deletePasskey(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<DeletePasskeyOutcome> {
  const owned = { id: input.credentialId, accountId: input.accountId };
  const paused = await db.teacher.findFirst({
    where: { accountId: input.accountId, deletedAt: null, paymentsPausedAt: { not: null } },
    select: { id: true },
  });
  if (paused !== null) {
    return (await db.passkeyCredential.count({ where: owned })) > 0 ? { status: 'payments_paused' } : { status: 'not_found' };
  }
  return db.$transaction(async (tx): Promise<DeletePasskeyOutcome> => {
    const credential = await tx.passkeyCredential.findFirst({ where: owned, select: { createdAt: true } });
    if (credential === null) return { status: 'not_found' };
    const { count } = await tx.passkeyCredential.deleteMany({ where: owned });
    if (count === 0) return { status: 'not_found' };
    const removal = await tx.removedPasskey.create({
      data: { accountId: input.accountId, credentialCreatedAt: credential.createdAt },
      select: { removedAt: true },
    });
    return { status: 'deleted', removedAt: removal.removedAt };
  });
}
