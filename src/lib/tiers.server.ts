import { log } from '@/lib/log';
import { DEFAULT_INCOME_TIER, isIncomeTier, type IncomeTier } from '@/lib/tiers';

/**
 * Narrow a tier read from the database.
 *
 * `Student.incomeTier` and `Registration.tierAtBooking` both carry a CHECK
 * constraint (see the income_tier_range_check migration), so the fallback
 * below is unreachable. It exists because the alternative on a bypassed
 * constraint is a 500 on a teacher's public booking page — `estimateTierPrices`
 * runs during SSR on `(public)/[slug]` and `(public)/[slug]/book/[classId]`,
 * fed straight from `registrations.map(r => r.tierAtBooking)`. One wrong price
 * with a warning beats a dead storefront.
 *
 * If this ever warns, the constraint was circumvented. That is the bug to
 * chase, and the log line is the only thing that would tell you.
 *
 * This file is separate from `tiers.ts` solely because it imports `@/lib/log`
 * (pino, server-only) and `tiers.ts` is value-imported by two `'use client'`
 * components. Do not move it, and do not import it from a client component.
 */
export function toIncomeTier(n: number): IncomeTier {
  if (isIncomeTier(n)) return n;
  log.warn({ tier: n }, 'income tier outside 1-5; DB constraint bypassed');
  return DEFAULT_INCOME_TIER;
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
 * interactive transaction, so this rolls it back, the class stays
 * `in_progress`, and the completion is retried.
 *
 * Unreachable in normal operation. `Registration.tierAtBooking` carries a
 * CHECK constraint (the income_tier_range_check migration). Every write to it
 * — including the initial stamp at booking and the re-stamp when a cancelled
 * registration is reactivated (in `activateRegistration`) — is sourced from
 * `Student.incomeTier`, which carries the same constraint. If this ever throws,
 * the constraint was bypassed and that is the bug to chase.
 */
export function toIncomeTierOrThrow(n: number): IncomeTier {
  if (isIncomeTier(n)) return n;
  throw new Error(
    `Income tier ${n} is outside 1-5 — refusing to price a class from it.`,
  );
}
