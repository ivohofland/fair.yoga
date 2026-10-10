import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { signOutEverywhereTx } from '@/services/account-sign-out';
import { lockForPasskeyRemoval, removePasskeyLocked } from '@/services/passkey-credentials';

/**
 * `revoked` carries the removal when one was written, so the caller can send
 * the removed notice once the transaction has committed; null when the passkey
 * was already gone or a pause kept it. `invalid` is the one answer for an
 * unknown, used or expired link.
 */
export type RevokeOutcome =
  | { status: 'revoked'; removal: { accountId: string; removedAt: Date } | null }
  | { status: 'invalid' };

/**
 * Redeems a passkey-added email's "This wasn't me" link: signs the account out
 * everywhere, deletes its pending sign-in links and removes the one passkey
 * the email is about, in one transaction
 * (`docs/superpowers/specs/2026-10-10-passkey-added-sign-out-link-design.md`).
 *
 * The account's live teacher row is the first lock, as for `deletePasskey`
 * (`docs/lock-order.md`); the token is consumed under it, so a failure in any
 * later statement rolls the consume back and the link still works. The removal
 * is `removePasskeyLocked`, the step `deletePasskey` shares, so a removal by
 * link is recorded for the payout gate; a paused account keeps its passkey and
 * is still signed out. The sessions that existed are deleted before the
 * passkey, so the delete's `SET NULL` reaches only a session a passkey sign-in
 * inserted between the two.
 */
export async function revokePasskeyByLink(
  db: PrismaClient,
  rawToken: string,
  now: Date = new Date(),
): Promise<RevokeOutcome> {
  const tokenHash = hashToken(rawToken);
  return db.$transaction(async (tx): Promise<RevokeOutcome> => {
    const token = await tx.passkeyRevokeToken.findUnique({
      where: { tokenHash },
      select: { accountId: true, credentialId: true },
    });
    if (token === null) return { status: 'invalid' };

    const { paused } = await lockForPasskeyRemoval(tx, token.accountId);

    const consumed = await tx.passkeyRevokeToken.deleteMany({ where: { tokenHash, expiresAt: { gt: now } } });
    if (consumed.count === 0) return { status: 'invalid' };

    const account = await tx.account.findUniqueOrThrow({ where: { id: token.accountId }, select: { email: true } });
    await signOutEverywhereTx(tx, token.accountId);
    await tx.magicLinkToken.deleteMany({ where: { email: account.email } });

    if (paused) return { status: 'revoked', removal: null };
    const removed = await removePasskeyLocked(tx, token);
    return {
      status: 'revoked',
      removal: removed.status === 'deleted' ? { accountId: token.accountId, removedAt: removed.removedAt } : null,
    };
  });
}
