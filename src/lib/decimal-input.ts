const DECIMAL_SHAPE = /^-?(\d+([.,]\d*)?|[.,]\d+)$/;

/**
 * Reads one decimal amount from typed text, or NaN when the text is not one.
 *
 * - Surrounding whitespace is trimmed; blank text is NaN.
 * - The text is an optional minus, digits, and at most one separator, which
 *   may be `,` or `.`. Grouping characters (a second separator, spaces) are
 *   refused.
 * - More than `maxDecimals` digits after the separator is NaN, so `1.000` and
 *   `1,000` are refused at 2 decimals instead of read as 1. `Infinity` sets
 *   no limit.
 */
export function parseDecimal(text: string, maxDecimals: number): number {
  const trimmed = text.trim();
  if (!DECIMAL_SHAPE.test(trimmed)) return NaN;
  const normalized = trimmed.replace(',', '.');
  const separator = normalized.indexOf('.');
  if (separator !== -1 && normalized.length - separator - 1 > maxDecimals) {
    return NaN;
  }
  return Number(normalized);
}
