import crypto from 'crypto';
import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { hashToken, consumeTokenRow } from './magic-link';
import { hashNonce } from './origin-nonce';

export type HandoffOutcome =
  | { kind: 'verified'; email: string; redirectTo: string | null; purpose: MagicLinkPurpose }
  | { kind: 'handoff'; code: string }
  | { kind: 'invalid' };

/** `randomInt` is rejection-sampled, so every code is equally likely.
 *  `randomBytes(n) % 1_000_000` would not be. */
function generateHandoffCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Decides what a link-open does, given the browser that opened it.
 *
 * A matching nonce consumes the token, exactly as before. Anything else —
 * no cookie, or another browser's — consumes NOTHING and stamps a code the
 * user carries back. That branch is what a mail scanner reaches, which is why
 * it must leave the row spendable.
 *
 * Deliberately not routed through `verifyMagicLinkToken`: this decision has
 * to inspect the row before choosing whether to consume it, and
 * `verifyMagicLinkToken` has another caller that must never reach this
 * decision — see the spec's §3.
 */
export async function verifyWithHandoff(
  db: PrismaClient,
  token: string,
  nonce: string | null,
): Promise<HandoffOutcome> {
  const row = await db.magicLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return { kind: 'invalid' };
  if (row.expiresAt <= new Date()) return { kind: 'invalid' };

  const sameBrowser = nonce !== null && row.originBrowserHash === hashNonce(nonce);

  if (sameBrowser) {
    if (!(await consumeTokenRow(db, row))) return { kind: 'invalid' };
    return {
      kind: 'verified',
      email: row.email,
      redirectTo: row.redirectTo,
      purpose: row.purpose,
    };
  }

  // Stamped once and reused. Regenerating per open would let anyone holding
  // the link invalidate a code the owner is mid-way through typing — which is
  // also why this column is readable rather than hashed.
  if (row.handoffCode) return { kind: 'handoff', code: row.handoffCode };

  const code = generateHandoffCode();
  await db.magicLinkToken.update({
    where: { id: row.id },
    data: { handoffCode: code },
  });
  return { kind: 'handoff', code };
}

/** A 6-digit code is 10⁶, brute-forceable inside the token's fifteen minutes.
 *  This budget is the guard that does not depend on the nonce staying secret. */
export const HANDOFF_MAX_ATTEMPTS = 5;

/**
 * Trades a code for the token it was stamped on, for the browser that
 * requested the link.
 *
 * Looks up by nonce rather than by code, so a wrong guess still finds the row
 * whose budget it must spend. Looking up by both would leave the attempt
 * counter unreachable and the budget unenforceable.
 */
export async function claimWithCode(
  db: PrismaClient,
  nonce: string | null,
  code: string,
): Promise<HandoffOutcome> {
  if (nonce === null) return { kind: 'invalid' };

  const row = await db.magicLinkToken.findFirst({
    where: { originBrowserHash: hashNonce(nonce), handoffCode: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { kind: 'invalid' };

  if (row.handoffAttempts >= HANDOFF_MAX_ATTEMPTS) {
    await db.magicLinkToken.deleteMany({ where: { id: row.id } });
    return { kind: 'invalid' };
  }

  if (row.handoffCode !== code) {
    const spent = row.handoffAttempts + 1;
    await db.magicLinkToken.update({
      where: { id: row.id },
      data: { handoffAttempts: spent },
    });
    if (spent >= HANDOFF_MAX_ATTEMPTS) {
      await db.magicLinkToken.deleteMany({ where: { id: row.id } });
    }
    return { kind: 'invalid' };
  }

  if (!(await consumeTokenRow(db, row))) return { kind: 'invalid' };
  return { kind: 'verified', email: row.email, redirectTo: row.redirectTo, purpose: row.purpose };
}
