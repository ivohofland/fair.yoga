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
