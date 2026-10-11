export const VAT_PERCENT_MAX = 100;
export const VAT_PERCENT_DECIMALS = 3;

const SCALE = 10 ** VAT_PERCENT_DECIMALS;

/**
 * The copy for why `value` is not a VAT percentage, or null when it is one.
 * The decimals rule is checked here because `numeric(6,3)` would round a
 * fourth decimal silently instead of refusing it.
 */
export function vatPercentViolation(value: number): string | null {
  if (value < 0) return "VAT can't be negative.";
  if (value > VAT_PERCENT_MAX) return `Keep VAT to ${VAT_PERCENT_MAX}% or less.`;
  const scaled = value * SCALE;
  // Tolerance absorbs binary representation: 14.975 * 1000 is 14974.999999999998.
  if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-6) {
    return `Use at most ${VAT_PERCENT_DECIMALS} decimals for VAT.`;
  }
  return null;
}
