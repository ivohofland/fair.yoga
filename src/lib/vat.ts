export const VAT_PERCENT_MAX = 100;
export const VAT_PERCENT_DECIMALS = 3;

const SCALE = 10 ** VAT_PERCENT_DECIMALS;

/**
 * The copy for why `value` is not a VAT percentage, or null when it is one.
 * It checks the decimals itself because the database would round a longer
 * value rather than refuse it.
 */
export function vatPercentViolation(value: number): string | null {
  if (!Number.isFinite(value)) return 'Enter a number for VAT.';
  if (value < 0) return "VAT can't be negative.";
  if (value > VAT_PERCENT_MAX) return `Keep VAT to ${VAT_PERCENT_MAX}% or less.`;
  const scaled = value * SCALE;
  // Tolerance absorbs binary representation: 1.001 * 1000 is 1000.9999999999999.
  if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    return `Use at most ${VAT_PERCENT_DECIMALS} decimals for VAT.`;
  }
  return null;
}
