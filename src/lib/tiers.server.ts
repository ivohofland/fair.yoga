import { log } from '@/lib/log';
import { DEFAULT_INCOME_TIER, isIncomeTier, type IncomeTier } from '@/lib/tiers';

/**
 * Read a tier from the database, answering `null` when the stored value is
 * not one.
 *
 * `Student.incomeTier` and `Registration.tierAtBooking` both carry a CHECK
 * constraint (see the income_tier_range_check migration), so `null` is
 * unreachable. It exists because the alternatives on a bypassed constraint
 * are both bad: a 500 on a teacher's public booking page, or a confident
 * statement about a value nobody knows.
 *
 * Choose between this and `toIncomeTier` by asking whose tier it is. A tier a
 * surface will speak about as THIS person's — the price it quotes them, the
 * tier it names back to them, the picker it seeds — is read here, and `null`
 * means that surface must not make the claim. A tier joining an aggregate
 * over other people keeps `toIncomeTier`: there is no honest per-person UI
 * for "someone else's row is corrupt", and one substituted ratio only nudges
 * a shared price.
 *
 * If this ever warns, the constraint was circumvented. That is the bug to
 * chase, and the log line is the only thing that would tell you.
 *
 * This file is separate from `tiers.ts` solely because it imports `@/lib/log`
 * (pino, server-only) and `tiers.ts` is value-imported by `'use client'`
 * components. Do not move it, and do not import it from a client component.
 *
 * `context` is merged into the log payload — pass whichever id is in hand at
 * the call site (`registrationId` when a registration is in hand, `studentId`
 * on a profile read) so a warning points at the row, not just the bad value.
 */
export function readIncomeTier(
  n: number,
  context?: Record<string, string>,
): IncomeTier | null {
  if (isIncomeTier(n)) return n;
  log.warn({ tier: n, ...context }, 'income tier outside 1-5; DB constraint bypassed');
  return null;
}

/**
 * Narrow a tier read from the database, substituting the median when the
 * stored value is not one.
 *
 * The substitution is what keeps a public booking page rendering rather than
 * 500ing over one bad row: the tier estimates run during SSR and are fed the
 * tiers of everyone registered. One wrong price with a warning beats a dead
 * storefront.
 *
 * That trade is only right where the substituted value disappears into an
 * aggregate. Where a surface would state the tier as a named person's, use
 * `readIncomeTier` above and let `null` suppress the claim; where a wrong
 * value would be billed, use `toIncomeTierOrThrow` below.
 *
 * Warning and log payload are `readIncomeTier`'s — this is the same read with
 * a substitution on the end, not a second one.
 */
export function toIncomeTier(n: number, context?: Record<string, string>): IncomeTier {
  return readIncomeTier(n, context) ?? DEFAULT_INCOME_TIER;
}

/**
 * Narrow a tier on the billing path, where a wrong value must not be guessed.
 *
 * The sibling `toIncomeTier` degrades to the median tier so a public booking
 * page renders rather than 500s over one bad row. That trade is wrong here:
 * `completeClass` writes the resulting price to `Registration`, creates a
 * `Payment` for it, and notifies the student — so a substituted tier is a
 * silent mis-charge, recoverable only by hand.
 *
 * Throwing is free at that call site: `completeClass`'s body is a single
 * interactive transaction, so this rolls it back — the class reverts to
 * whatever status it was in before the call — and the completion is retried.
 *
 * Unreachable in normal operation. `Registration.tierAtBooking` carries a
 * CHECK constraint (the income_tier_range_check migration). Every write to it
 * — including the initial stamp at booking and the re-stamp when a cancelled
 * registration is reactivated (in `activateRegistration`) — is sourced from
 * `Student.incomeTier`, which carries the same constraint. If this ever throws,
 * the constraint was bypassed and that is the bug to chase.
 *
 * `context` is merged into the log payload and named in the error message —
 * see `toIncomeTier` above.
 */
export function toIncomeTierOrThrow(n: number, context?: Record<string, string>): IncomeTier {
  if (isIncomeTier(n)) return n;
  const where = context
    ? ` (${Object.entries(context)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')})`
    : '';
  throw new Error(
    `Income tier ${n} is outside 1-5 — refusing to price a class from it.${where}`,
  );
}
