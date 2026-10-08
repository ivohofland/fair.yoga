import type { Prisma, PrismaClient } from '@prisma/client';
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

/**
 * The window start when no event lies at or after the floor: the token's own
 * event, unless it predates the last resume, which confirmed it; then the
 * floor.
 */
function tokenEventOrFloor(tokenEventAt: Date, paymentsResumedAt: Date | null, floor: Date): Date {
  return paymentsResumedAt === null || tokenEventAt >= paymentsResumedAt ? tokenEventAt : floor;
}

/** A passkey created at or after this instant is not trusted to resume. */
export function pausePasskeyCutoff(windowStart: Date): Date {
  return new Date(windowStart.getTime() - PAUSE_PASSKEY_LOOKBACK_DAYS * DAY_MS);
}

/**
 * Whether the account holds a passkey created before `cutoff`, or removed one
 * at or after `cutoff`: a removal inside the lookback must not lift the
 * requirement the passkey would have set
 * (`docs/superpowers/specs/2026-10-08-payout-change-alert-design.md`,
 * Decision 4). The standing passkeys are read first: `deletePasskey` deletes
 * and records in one transaction, so a removal committing between the two
 * reads moves its passkey from the first read's set into the second's, never
 * out of both.
 */
async function heldPasskeyBefore(tx: Prisma.TransactionClient, accountId: string, cutoff: Date): Promise<boolean> {
  const standing = await tx.passkeyCredential.count({ where: { accountId, createdAt: { lt: cutoff } } });
  if (standing > 0) return true;
  const removed = await tx.removedPasskey.count({
    where: { accountId, credentialCreatedAt: { lt: cutoff }, removedAt: { gte: cutoff } },
  });
  return removed > 0;
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
 * lock"). The sessions that existed are deleted before the passkeys. A
 * passkey sign-in landing between the two leaves a session whose credential
 * the passkey delete then nulls, and a session with no credential cannot
 * satisfy a resume.
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
      select: {
        accountId: true,
        paymentsPausedAt: true,
        paymentsResumedAt: true,
        pausePasskeyCutoff: true,
        account: { select: { email: true } },
      },
    });
    const floor = pauseWindowFloor(now, teacher.paymentsResumedAt);
    const earliest = await tx.payoutChangeEvent.findFirst({
      where: { teacherId: token.teacherId, createdAt: { gte: floor } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const windowStart = earliest?.createdAt ?? tokenEventOrFloor(token.event.createdAt, teacher.paymentsResumedAt, floor);
    const cutoff = pausePasskeyCutoff(windowStart);

    if (teacher.paymentsPausedAt === null) {
      const required = await heldPasskeyBefore(tx, teacher.accountId, cutoff);
      await tx.teacher.update({
        where: { id: token.teacherId },
        data: { paymentsPausedAt: now, pauseWindowStart: windowStart, pausePasskeyCutoff: required ? cutoff : null },
      });
    }

    await signOutEverywhereTx(tx, teacher.accountId);
    await tx.magicLinkToken.deleteMany({ where: { email: teacher.account.email } });
    // A frozen cutoff later than this pause's own keeps every passkey it made
    // eligible to resume.
    const frozen = teacher.pausePasskeyCutoff;
    const removeFrom = frozen !== null && frozen > cutoff ? frozen : cutoff;
    // No `RemovedPasskey` for these: each was created at or after a cutoff, so
    // could never count toward one.
    await tx.passkeyCredential.deleteMany({ where: { accountId: teacher.accountId, createdAt: { gte: removeFrom } } });
    return { status: 'paused' };
  });
}
