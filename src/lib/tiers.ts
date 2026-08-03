import type { NoneOf } from '@/lib/type-pins';

/**
 * One of five discrete income bands. Ratios live in TIER_RATIOS below; the
 * database enforces the same range through two CHECK constraints (see the
 * income_tier_range_check migration), so this union and the columns agree.
 *
 * This module must ship no runtime imports: `tier-form.tsx`, `booking-flow.tsx`,
 * and `pricing-preview-table.tsx` are all `'use client'` and value-import from
 * it, so any transitive reach to `@/lib/log` (pino) would land in the browser
 * bundle. The narrowing helper that logs lives in `tiers.server.ts` for
 * exactly that reason. A type-only import is safe here and is why the pins
 * below can import `NoneOf` from `type-pins.ts`: `import type` erases
 * completely at compile time, so nothing is emitted for it and no runtime
 * import reaches the browser bundle.
 */
export type IncomeTier = 1 | 2 | 3 | 4 | 5;

/** Every tier, in order. Use this instead of a hand-rolled 1..5 loop. */
export const INCOME_TIERS = [1, 2, 3, 4, 5] as const satisfies readonly IncomeTier[];

// `satisfies` above proves every element IS a tier; these prove the list is
// the whole union and nothing more. A missing tier silently shortens the
// pricing tables that iterate this — `pricing-preview.tsx` and
// `pricing-breakdown.tsx`.
const _tiersCoverTheUnion: NoneOf<Exclude<IncomeTier, (typeof INCOME_TIERS)[number]>> = true;
void _tiersCoverTheUnion;
const _tiersHasNoExtras: NoneOf<Exclude<(typeof INCOME_TIERS)[number], IncomeTier>> = true;
void _tiersHasNoExtras;

export function isIncomeTier(n: number): n is IncomeTier {
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5;
}

// The middle tier: the default for new student profiles and the value
// erased profiles are reset to.
export const DEFAULT_INCOME_TIER: IncomeTier = 3;

/**
 * Income tier ratios. Tier 3 is baseline (1.0). Max spread ~2.08×.
 *
 * A `Record<IncomeTier, number>` rather than `Record<number, number>`: with a
 * finite key type, `TIER_RATIOS[tier]` is `number`, not `number | undefined`,
 * even under `noUncheckedIndexedAccess`. That is what let the engine's
 * per-student `Invalid tier` throw be deleted rather than relocated.
 *
 * Lives here rather than in `services/pricing.ts` so that a client component
 * can read the ratios from a module with no runtime imports — this file has
 * none (the `import type` above erases completely).
 * (`pricing-preview-table.tsx` also imports `calculateEffectiveTeacherRate`
 * from `services/pricing.ts` directly, so the engine itself is in the browser
 * bundle regardless; that is not what living here buys.) See
 * `src/lib/class-fields.ts` for the same reasoning applied to ECONOMIC_FIELDS.
 */
export const TIER_RATIOS: Record<IncomeTier, number> = {
  1: 0.65,
  2: 0.80,
  3: 1.00,
  4: 1.20,
  5: 1.35,
};

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
