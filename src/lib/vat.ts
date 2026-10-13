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

/** Hundred percent, in thousandths of a percent. */
const WHOLE = 100 * SCALE;

/** A percentage of at most `VAT_PERCENT_DECIMALS` decimals as whole thousandths: 14.975 → 14975. */
export function vatThousandths(percent: number): number {
  return Math.round(percent * SCALE);
}

/**
 * `amount` with VAT added. The factor is computed first so that at 0% it is
 * exactly 1 and the amount comes back unchanged, bit for bit.
 */
export function withVat(amount: number, thousandths: number): number {
  return amount * ((WHOLE + thousandths) / WHOLE);
}

/** The VAT added on top of a VAT-exclusive amount, in whole cents. */
export function addedVatCents(baseCents: number, thousandths: number): number {
  return Math.round((baseCents * thousandths) / WHOLE);
}

/** The VAT contained in a VAT-inclusive price, in whole cents. */
export function includedVatCents(priceCents: number, thousandths: number): number {
  return Math.round((priceCents * thousandths) / (WHOLE + thousandths));
}
