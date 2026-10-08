import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import { signOutEverywhereTx } from '@/services/account-sign-out';
import { PAUSE_TOKEN_TTL_DAYS } from '@/services/payout-pause-token';

/**
 * How far before the pause's window start a passkey must have been created to
 * count as the teacher's own: one created later could be a thief's.
 */
export const PAUSE_PASSKEY_LOOKBACK_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `invalid` is the one answer for an unknown, used, expired or erased
 * teacher's link, and a second link while already paused answers `paused`:
 * a caller holding only a link learns nothing about the pause state.
 */
export type PauseOutcome = { status: 'paused' } | { status: 'invalid' };

/**
 * The earliest instant a pause's window may start: the last resume, or the
 * oldest moment a still-working link could have been minted, whichever is
 * later. An event before it was either confirmed by that resume or is too old
 * for any link to still pause on.
 */
export function pauseWindowFloor(now: Date, paymentsResumedAt: Date | null): Date {
  const ttlFloor = new Date(now.getTime() - PAUSE_TOKEN_TTL_DAYS * DAY_MS);
  return paymentsResumedAt !== null && paymentsResumedAt > ttlFloor ? paymentsResumedAt : ttlFloor;
}

/** A passkey created at or after this instant is not trusted to resume. */
export function pausePasskeyCutoff(windowStart: Date): Date {
  return new Date(windowStart.getTime() - PAUSE_PASSKEY_LOOKBACK_DAYS * DAY_MS);
}

/**
 * Redeems a "This wasn't me" link: pauses the teacher's payments, signs every
 * device out and removes the passkeys created at or after the cutoff, in one
 * transaction (`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`,
 * "2 · Pausing").
 *
 * The token is consumed inside that transaction, so a failure in any later
 * statement rolls the consume back and the link still works. The teacher row
 * is the first lock (`docs/lock-order.md`, "The `Teacher` row is the first
 * lock"). Sessions are deleted before passkeys, so the passkey delete finds no
 * session left to null out.
 */
export async function pausePayments(db: PrismaClient, rawToken: string, now: Date = new Date()): Promise<PauseOutcome> {
  const tokenHash = hashToken(rawToken);
  return db.$transaction(async (tx): Promise<PauseOutcome> => {
    const token = await tx.payoutPauseToken.findUnique({
      where: { tokenHash },
      select: { teacherId: true, event: { select: { createdAt: true } } },
    });
    if (token === null) return { status: 'invalid' };
    if ((await lockTeacherForNoKeyUpdate(tx, token.teacherId)) === null) return { status: 'invalid' };

    const consumed = await tx.payoutPauseToken.deleteMany({ where: { tokenHash, expiresAt: { gt: now } } });
    if (consumed.count === 0) return { status: 'invalid' };

    const teacher = await tx.teacher.findUniqueOrThrow({
      where: { id: token.teacherId },
      select: { accountId: true, paymentsPausedAt: true, paymentsResumedAt: true, account: { select: { email: true } } },
    });
    const earliest = await tx.payoutChangeEvent.findFirst({
      where: { teacherId: token.teacherId, createdAt: { gte: pauseWindowFloor(now, teacher.paymentsResumedAt) } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const windowStart = earliest?.createdAt ?? token.event.createdAt;
    const cutoff = pausePasskeyCutoff(windowStart);

    if (teacher.paymentsPausedAt === null) {
      const trusted = await tx.passkeyCredential.count({ where: { accountId: teacher.accountId, createdAt: { lt: cutoff } } });
      await tx.teacher.update({
        where: { id: token.teacherId },
        data: { paymentsPausedAt: now, pauseWindowStart: windowStart, pausePasskeyCutoff: trusted > 0 ? cutoff : null },
      });
    }

    await signOutEverywhereTx(tx, teacher.accountId);
    await tx.magicLinkToken.deleteMany({ where: { email: teacher.account.email } });
    await tx.passkeyCredential.deleteMany({ where: { accountId: teacher.accountId, createdAt: { gte: cutoff } } });
    return { status: 'paused' };
  });
}
