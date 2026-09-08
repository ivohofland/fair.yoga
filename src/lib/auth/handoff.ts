import crypto from 'crypto';
import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { hashToken, consumeTokenRow } from './magic-link';
import { hashNonce, type BrowserNonce } from './origin-nonce';
import { log } from '@/lib/log';

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
 * to inspect the row before choosing whether to consume it — see
 * `docs/superpowers/specs/2026-09-03-magic-link-device-handoff-design.md` §3.
 */
export async function verifyWithHandoff(
  db: PrismaClient,
  token: string,
  nonce: BrowserNonce | null,
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

  // A token minted before this feature has no origin to hand off to — its
  // code could never be claimed, so don't stamp one.
  if (row.originBrowserHash === null) return { kind: 'invalid' };

  // Stamped once and reused. Regenerating per open would let anyone holding
  // the link invalidate a code the owner is mid-way through typing — which is
  // also why this column is readable rather than hashed.
  if (row.handoffCode) return { kind: 'handoff', code: row.handoffCode };

  const code = generateHandoffCode();
  // Compare-and-swap, not a bare write: two concurrent first-opens of the
  // same never-before-opened link both read `handoffCode: null` above, each
  // generates its OWN code, and an unconditional write would let one silently
  // overwrite the other — the winner's caller gets a code that matches the
  // row, the loser's caller gets a code that was never persisted and can
  // never be claimed. Gating the write on `handoffCode: null` still holding
  // means only one of them actually stamps; the loser reads back and returns
  // whichever code won.
  const stamped = await db.magicLinkToken.updateMany({
    where: { id: row.id, handoffCode: null },
    data: { handoffCode: code },
  });
  if (stamped.count === 0) {
    // Lost the race: a concurrent opener already stamped a code first.
    // Return theirs — ours was never persisted.
    const winner = await db.magicLinkToken.findUnique({ where: { id: row.id } });
    if (!winner?.handoffCode) return { kind: 'invalid' };
    return { kind: 'handoff', code: winner.handoffCode };
  }
  return { kind: 'handoff', code };
}

/** A 6-digit code is 10⁶, brute-forceable inside the token's fifteen minutes.
 *  Per BROWSER, not per token: a wrong code submitted under one nonce is
 *  charged against every live token that nonce could be claiming, not just
 *  the one it was aimed at. A per-token budget
 *  is steerable by a caller who can mint tokens under the nonce, so this
 *  scoping is what makes it the guard that does not depend on the nonce
 *  staying secret. */
export const HANDOFF_MAX_ATTEMPTS = 5;

/**
 * Trades a code for the token it was stamped on, for the browser that
 * requested the link.
 *
 * Looks up by nonce rather than by code, so a wrong guess still finds rows
 * whose budget it must spend. Looking up by both would leave the attempt
 * counter unreachable and the budget unenforceable.
 *
 * A resend legitimately leaves more than one live token sharing this
 * browser's nonce, and either can end up stamped with its own code if both
 * get opened elsewhere. The submitted code is compared against every live
 * candidate at once, so a match claims that specific token, and a code
 * matching none of them is one failed guess against ALL of them — charged to
 * all of them. Charging one chosen row instead undercounts, and lets a caller
 * who can mint tokens under this nonce steer the charge off the token being
 * guessed at.
 */
export async function claimWithCode(
  db: PrismaClient,
  nonce: BrowserNonce | null,
  code: string,
): Promise<Exclude<HandoffOutcome, { kind: 'handoff' }>> {
  if (nonce === null) return { kind: 'invalid' };

  const candidates = await db.magicLinkToken.findMany({
    where: {
      // Scoped to the browser, not to an address. A shared browser carries one
      // nonce across an abandoned sign-in, so another person's stamped token
      // can sit in this set and shares the budget spent below — an accepted
      // consequence, argued in
      // `docs/superpowers/specs/2026-09-08-handoff-attempt-budget-design.md` §5.
      originBrowserHash: hashNonce(nonce),
      handoffCode: { not: null },
      expiresAt: { gt: new Date() },
    },
    // Not load-bearing for the budget: a miss charges every live candidate.
    // It settles the tie-break if two live candidates ever stamp the same
    // code — the newest wins, rather than whatever order the database
    // happened to return.
    orderBy: { createdAt: 'desc' },
  });
  if (candidates.length === 0) return { kind: 'invalid' };

  // An exhausted row is dead to a match as well as to a miss, so it leaves the
  // working set here. Deleted, not merely filtered out: a row can sit at or
  // past the budget without having been reaped — a crash between the increment
  // and the delete below, or a concurrent caller that has done the one and not
  // the other.
  const spent = candidates.filter((c) => c.handoffAttempts >= HANDOFF_MAX_ATTEMPTS);
  if (spent.length > 0) {
    const reapedSpent = await db.magicLinkToken.deleteMany({
      where: { id: { in: spent.map((c) => c.id) } },
    });
    if (reapedSpent.count !== spent.length) {
      log.warn(
        { expected: spent.length, actual: reapedSpent.count },
        'handoff: spent-candidate cleanup reaped a different number of rows than expected',
      );
    }
  }

  const live = candidates.filter((c) => c.handoffAttempts < HANDOFF_MAX_ATTEMPTS);
  if (live.length === 0) return { kind: 'invalid' };

  const match = live.find((candidate) => candidate.handoffCode === code);
  if (!match) {
    // Atomic per row, and `updateMany` rather than `update` so a row a
    // concurrent caller already consumed is a no-op instead of a P2025 to
    // catch. The delete re-reads the counter inside its own statement, so
    // whichever concurrent guess pushed a row over the line, the row dies.
    const ids = live.map((c) => c.id);
    // Expected reap count, derived from THIS call's own `live` snapshot,
    // taken before the increment below runs. A sibling call racing one of
    // these same rows can move its true count between this snapshot and the
    // writes below without this call ever seeing it (#504) — a mismatch
    // below is that documented race, not proof of a bug on its own. Which
    // interleaving produces which direction is derived in
    // `docs/superpowers/specs/2026-09-08-handoff-race-staging-design.md` §5.
    const expectedReaps = live.filter((c) => c.handoffAttempts + 1 >= HANDOFF_MAX_ATTEMPTS).length;

    const incremented = await db.magicLinkToken.updateMany({
      where: { id: { in: ids } },
      data: { handoffAttempts: { increment: 1 } },
    });
    if (incremented.count < ids.length) {
      log.warn(
        { requested: ids.length, affected: incremented.count },
        'handoff: updateMany affected fewer candidates than requested',
      );
    }

    const reaped = await db.magicLinkToken.deleteMany({
      where: { id: { in: ids }, handoffAttempts: { gte: HANDOFF_MAX_ATTEMPTS } },
    });
    if (reaped.count !== expectedReaps) {
      log.warn(
        { expected: expectedReaps, actual: reaped.count },
        'handoff: deleteMany reaped a different number of exhausted candidates than expected',
      );
    }

    return { kind: 'invalid' };
  }

  if (!(await consumeTokenRow(db, match))) return { kind: 'invalid' };
  return {
    kind: 'verified',
    email: match.email,
    redirectTo: match.redirectTo,
    purpose: match.purpose,
  };
}
