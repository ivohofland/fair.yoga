import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { lockAccountForSignOut } from '@/lib/db-locks';
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
 * The steps are `lockForPasskeyRemoval`, which takes the account's live
 * teacher row as the first lock (`docs/lock-order.md`), then
 * `lockAccountForSignOut` (`docs/lock-order.md`, "The `Account` row orders
 * multi-session sign-out writes"), and then `removePasskeyLocked`; the token
 * is consumed under those locks, so a failure in
 * any later statement rolls the consume back and the link still works. A
 * removal by link is recorded for the payout gate; a paused account keeps its passkey and
 * is still signed out. The passkey goes before the sessions: a passkey
 * sign-in that inserts a `Session` after the passkey's delete fails its foreign
 * key, and one that inserted before it is caught by the session delete that
 * follows. Sessions first would let a sign-in land between the two deletes and
 * survive, its `passkeyCredentialId` merely nulled.
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
    const lock = await lockAccountForSignOut(tx, token.accountId);
    if (lock === null) return { status: 'invalid' };

    const consumed = await tx.passkeyRevokeToken.deleteMany({ where: { tokenHash, expiresAt: { gt: now } } });
    if (consumed.count === 0) return { status: 'invalid' };

    const account = await tx.account.findUniqueOrThrow({ where: { id: token.accountId }, select: { email: true } });
    const removed = paused ? null : await removePasskeyLocked(tx, lock, token.credentialId);
    await signOutEverywhereTx(tx, lock);
    await tx.magicLinkToken.deleteMany({ where: { email: account.email } });

    return {
      status: 'revoked',
      removal: removed !== null && removed.status === 'deleted' ? { accountId: token.accountId, removedAt: removed.removedAt } : null,
    };
  });
}
