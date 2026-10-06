import { INCOME_TIERS, TIER_RATIOS, type IncomeTier } from '@/lib/tiers';

/** Students in each tier of one class. */
export type TierCounts = Readonly<Record<IncomeTier, number>>;

/** Each tier's price, in euros. */
export type TierPrices = Readonly<Record<IncomeTier, number>>;

/** A record with an entry for every tier — a new tier fails to compile here. */
function byTier(value: (tier: IncomeTier) => number): Record<IncomeTier, number> {
  return { 1: value(1), 2: value(2), 3: value(3), 4: value(4), 5: value(5) };
}

/** Expected share of a class in each tier. */
const NORMAL_WEIGHTS: TierCounts = { 1: 0.0895, 2: 0.2242, 3: 0.3726, 4: 0.2242, 5: 0.0895 };

/** The centre of the spread, which wins ties when handing out remainders. */
const MIDDLE_TIER: IncomeTier = 3;

export function studentsIn(counts: TierCounts): number {
  return INCOME_TIERS.reduce((sum, tier) => sum + counts[tier], 0);
}

/** Students per tier for a class of `n`, largest-remainder rounded. */
export function normalSpread(n: number): TierCounts {
  const counts = byTier((tier) => Math.floor(NORMAL_WEIGHTS[tier] * n));
  let remaining = n - studentsIn(counts);

  // Distribute remainders to tiers with largest fractional parts (center-first tiebreak)
  const fractions = INCOME_TIERS.map((tier) => ({
    tier,
    frac: NORMAL_WEIGHTS[tier] * n - counts[tier],
  }));
  fractions.sort((a, b) => {
    if (b.frac !== a.frac) return b.frac - a.frac;
    return Math.abs(a.tier - MIDDLE_TIER) - Math.abs(b.tier - MIDDLE_TIER);
  });

  for (const { tier } of fractions) {
    if (remaining <= 0) break;
    counts[tier]++;
    remaining--;
  }

  return counts;
}

/** Each tier's price for a class costing `total`, rounded to the cent per tier. */
export function tierPrices(total: number, counts: TierCounts): TierPrices {
  const weightedSum = INCOME_TIERS.reduce(
    (sum, tier) => sum + counts[tier] * TIER_RATIOS[tier],
    0,
  );

  if (weightedSum === 0) return byTier(() => 0);

  return byTier((tier) => Math.round(((total / weightedSum) * TIER_RATIOS[tier]) * 100) / 100);
}

/** Highest over lowest price among occupied tiers, one decimal. */
export function priceSpread(prices: TierPrices, counts: TierCounts): string | null {
  const active = INCOME_TIERS.filter((tier) => counts[tier] > 0).map((tier) => prices[tier]);
  return active.length >= 2 ? (Math.max(...active) / Math.min(...active)).toFixed(1) : null;
}

/** An empty class, for building counts one student at a time. */
export function emptyCounts(): Record<IncomeTier, number> {
  return byTier(() => 0);
}
