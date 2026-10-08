import type { PrismaClient } from '@prisma/client';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';

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
 * `RemovedPasskey` in the same transaction, so the passkey is never neither
 * standing nor recorded as removed (what reads that:
 * `docs/technical-architecture.md`, "Resuming paused payments"). The filter
 * carries `accountId`, so a credential of another account is
 * indistinguishable from one that does not exist: both answer `not_found`.
 *
 * Refused while the account's teacher has payments paused. The check is read
 * under the teacher row's lock, taken first (`docs/lock-order.md`, "The
 * `Teacher` row is the first lock"), so a pause and a removal serialise and
 * the refusal is exact. Why a removal before a pause cannot lift the passkey
 * requirement: `docs/technical-architecture.md`, "Resuming paused payments".
 * An account with no live teacher profile is never paused and takes no
 * teacher lock.
 */
export async function deletePasskey(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<DeletePasskeyOutcome> {
  const owned = { id: input.credentialId, accountId: input.accountId };
  return db.$transaction(async (tx): Promise<DeletePasskeyOutcome> => {
    const teacher = await tx.teacher.findFirst({
      where: { accountId: input.accountId, deletedAt: null },
      select: { id: true },
    });
    if (teacher !== null && (await lockTeacherForNoKeyUpdate(tx, teacher.id)) !== null) {
      const { paymentsPausedAt } = await tx.teacher.findUniqueOrThrow({
        where: { id: teacher.id },
        select: { paymentsPausedAt: true },
      });
      if (paymentsPausedAt !== null) {
        return (await tx.passkeyCredential.count({ where: owned })) > 0
          ? { status: 'payments_paused' }
          : { status: 'not_found' };
      }
    }
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
