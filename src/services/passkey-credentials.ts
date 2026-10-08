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

/** `payments_paused`: the account's teacher has payments paused. */
export type DeletePasskeyOutcome = 'deleted' | 'not_found' | 'payments_paused';

/**
 * Remove one of the account's passkeys. The filter carries `accountId`, so a
 * credential of another account is indistinguishable from one that does not
 * exist: both answer `not_found`.
 *
 * Refused while the account's teacher has payments paused, so that someone
 * signed in on a stolen inbox cannot strip the teacher's passkeys. Resuming
 * reads the cutoff the pause froze, not the passkeys standing now, so a
 * delete that slips in as a pause commits changes nothing about who may
 * resume; this check is not under a lock for that reason. An account with no
 * teacher profile is never paused.
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
    return (await db.passkeyCredential.count({ where: owned })) > 0 ? 'payments_paused' : 'not_found';
  }
  const { count } = await db.passkeyCredential.deleteMany({ where: owned });
  return count > 0 ? 'deleted' : 'not_found';
}
