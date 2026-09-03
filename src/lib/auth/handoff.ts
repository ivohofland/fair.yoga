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
