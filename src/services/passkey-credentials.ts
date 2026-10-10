import type { PrismaClient } from '@prisma/client';
import {
  assertAccountSignOutLockHeldBy,
  lockAccountForSignOut,
  lockTeacherForNoKeyUpdate,
  type AccountSignOutLock,
  type TransactionClientOnly,
} from '@/lib/db-locks';

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
 * The account's live teacher row's lock, taken first (`docs/lock-order.md`,
 * "The `Teacher` row is the first lock"), and whether that teacher has
 * payments paused, read under it. An account with no live teacher profile is
 * never paused and takes no teacher lock.
 */
export async function lockForPasskeyRemoval(
  tx: TransactionClientOnly,
  accountId: string,
): Promise<{ paused: boolean }> {
  const teacher = await tx.teacher.findFirst({ where: { accountId, deletedAt: null }, select: { id: true } });
  if (teacher === null || (await lockTeacherForNoKeyUpdate(tx, teacher.id)) === null) return { paused: false };
  const { paymentsPausedAt } = await tx.teacher.findUniqueOrThrow({
    where: { id: teacher.id },
    select: { paymentsPausedAt: true },
  });
  return { paused: paymentsPausedAt !== null };
}

/**
 * Delete one of the account's passkeys and record the removal as a
 * `RemovedPasskey`, so the passkey is never neither standing nor recorded as
 * removed. The filter carries `accountId`: another account's credential is
 * indistinguishable from one that does not exist. The caller holds the lock
 * `lockForPasskeyRemoval` takes and has refused a paused account, and holds
 * `lock`, because the delete's `SET NULL` writes every session signed in with
 * the passkey (`docs/lock-order.md`, "The `Account` row orders multi-session
 * sign-out writes").
 */
export async function removePasskeyLocked(
  tx: TransactionClientOnly,
  lock: AccountSignOutLock,
  credentialId: string,
): Promise<{ status: 'deleted'; removedAt: Date } | { status: 'not_found' }> {
  assertAccountSignOutLockHeldBy(tx, lock);
  const owned = { id: credentialId, accountId: lock.accountId };
  const credential = await tx.passkeyCredential.findFirst({ where: owned, select: { createdAt: true } });
  if (credential === null) return { status: 'not_found' };
  const { count } = await tx.passkeyCredential.deleteMany({ where: owned });
  if (count === 0) return { status: 'not_found' };
  const removal = await tx.removedPasskey.create({
    data: { accountId: lock.accountId, credentialCreatedAt: credential.createdAt },
    select: { removedAt: true },
  });
  return { status: 'deleted', removedAt: removal.removedAt };
}

/**
 * All the account's passkeys, or those created at or after `createdFrom`. No
 * `RemovedPasskey` row: the caller decides none is owed. Held under `lock` for
 * the reason `removePasskeyLocked` is.
 */
export async function deleteAccountPasskeys(
  tx: TransactionClientOnly,
  lock: AccountSignOutLock,
  createdFrom: Date | null,
): Promise<number> {
  assertAccountSignOutLockHeldBy(tx, lock);
  const { count } = await tx.passkeyCredential.deleteMany({
    where: { accountId: lock.accountId, ...(createdFrom === null ? {} : { createdAt: { gte: createdFrom } }) },
  });
  return count;
}

/**
 * Remove one of the account's passkeys: `lockForPasskeyRemoval`, then
 * `lockAccountForSignOut`, then `removePasskeyLocked` (what reads the record it leaves:
 * `docs/technical-architecture.md`, "Resuming paused payments"). A credential
 * of another account is indistinguishable from one that does not exist: both
 * answer `not_found`.
 *
 * Refused while the account's teacher has payments paused, the check read
 * under the teacher row's lock so a pause and a removal serialise and the
 * refusal is exact. Why a removal before a pause cannot lift the passkey
 * requirement: `docs/technical-architecture.md`, "Resuming paused payments".
 */
export async function deletePasskey(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<DeletePasskeyOutcome> {
  return db.$transaction(async (tx): Promise<DeletePasskeyOutcome> => {
    const { paused } = await lockForPasskeyRemoval(tx, input.accountId);
    if (paused) {
      const owned = { id: input.credentialId, accountId: input.accountId };
      return (await tx.passkeyCredential.count({ where: owned })) > 0
        ? { status: 'payments_paused' }
        : { status: 'not_found' };
    }
    const lock = await lockAccountForSignOut(tx, input.accountId);
    if (lock === null) return { status: 'not_found' };
    return removePasskeyLocked(tx, lock, input.credentialId);
  });
}
