import { INCOME_TIERS, TIER_RATIOS } from '@/lib/tiers';

/** Expected share of a class in each tier, `INCOME_TIERS` order. */
const NORMAL_WEIGHTS = [0.0895, 0.2242, 0.3726, 0.2242, 0.0895];

/** Students per tier for a class of `n`, largest-remainder rounded. */
export function normalSpread(n: number): number[] {
  const raw = NORMAL_WEIGHTS.map((w) => w * n);
  const floored = raw.map(Math.floor);
  let remaining = n - floored.reduce((a, b) => a + b, 0);

  // Distribute remainders to tiers with largest fractional parts (center-first tiebreak)
  const fractions = raw.map((v, i) => ({ i, frac: v - floored[i]! }));
  fractions.sort((a, b) => {
    if (b.frac !== a.frac) return b.frac - a.frac;
    // Center-first tiebreak: closer to index 2 wins
    return Math.abs(a.i - 2) - Math.abs(b.i - 2);
  });

  for (const { i } of fractions) {
    if (remaining <= 0) break;
    floored[i]!++;
    remaining--;
  }

  return floored;
}

const TIER_RATIO_VALUES = INCOME_TIERS.map((t) => TIER_RATIOS[t]);

/**
 * Each tier's price for a class costing `total`, rounded to the cent per
 * tier. Billing (`calculateClassPricing`) allocates cents per student instead,
 * so a billed price can differ from this by a cent.
 */
export function tierPrices(total: number, distribution: readonly number[]): number[] {
  const weightedSum = distribution.reduce(
    (sum, count, i) => sum + count * TIER_RATIO_VALUES[i]!,
    0,
  );

  if (weightedSum === 0) return TIER_RATIO_VALUES.map(() => 0);

  return TIER_RATIO_VALUES.map(
    (ratio) => Math.round(((total / weightedSum) * ratio) * 100) / 100,
  );
}

/** Highest over lowest price among occupied tiers, one decimal. */
export function priceSpread(
  prices: readonly number[],
  distribution: readonly number[],
): string | null {
  const active = prices.filter((_, i) => distribution[i]! > 0);
  return active.length >= 2 ? (Math.max(...active) / Math.min(...active)).toFixed(1) : null;
}
