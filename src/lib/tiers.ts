/**
 * One of five discrete income bands. Ratios live in TIER_RATIOS below; the
 * database enforces the same range through two CHECK constraints (see the
 * income_tier_range_check migration), so this union and the columns agree.
 *
 * This module must stay import-free: `tier-form.tsx` and `booking-flow.tsx`
 * are `'use client'` and value-import from it, so any transitive reach to
 * `@/lib/log` (pino) would land in the browser bundle. The narrowing helper
 * that logs lives in `tiers.server.ts` for exactly that reason.
 */
export type IncomeTier = 1 | 2 | 3 | 4 | 5;

/** Every tier, in order. Use this instead of a hand-rolled 1..5 loop. */
export const INCOME_TIERS = [1, 2, 3, 4, 5] as const satisfies readonly IncomeTier[];

export function isIncomeTier(n: number): n is IncomeTier {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

// The middle tier: the default for new student profiles and the value
// erased profiles are reset to.
export const DEFAULT_INCOME_TIER: IncomeTier = 3;

/** Tier display copy — accessible language, inviting, never guilt-inducing. */
export const TIER_INFO = [
  { tier: 1, label: 'Getting by', caption: 'Money is tight right now' },
  { tier: 2, label: 'Managing', caption: 'Covering the basics' },
  { tier: 3, label: 'Comfortable', caption: 'Comfortable, with some room' },
  { tier: 4, label: 'Doing well', caption: 'Doing well financially' },
  { tier: 5, label: 'Plenty to share', caption: 'Happy to support others' },
] as const;

export const TIER_QUOTE = {
  text: 'Yoga is not about touching your toes. It is about what you learn on the way down.',
  author: 'Judith Hanson Lasater',
} as const;
