import type { Currency, Prisma } from '@prisma/client';
import { CURRENCIES, formatMoneyCents } from '@/lib/format';

/** One total per currency present, never across currencies. */
export type MoneyTotals = ReadonlyArray<{ currency: Currency; cents: number }>;

/**
 * Sums `items` per currency in whole cents: each amount is rounded to cents
 * before it is added, so the sum is integer arithmetic with no float drift.
 * Order: `first` (the teacher's current currency) when present, then the
 * rest in `CURRENCIES` order.
 */
export function totalsByCurrency(
  items: Iterable<{ currency: Currency; amount: number | Prisma.Decimal }>,
  first: Currency,
): MoneyTotals {
  const sums = new Map<Currency, number>();
  for (const { currency, amount } of items) {
    const n = typeof amount === 'number' ? amount : amount.toNumber();
    sums.set(currency, (sums.get(currency) ?? 0) + Math.round(n * 100));
  }
  const order = [first, ...CURRENCIES.filter((c) => c !== first)];
  return order.flatMap((currency) => {
    const cents = sums.get(currency);
    return cents === undefined ? [] : [{ currency, cents }];
  });
}

/** For a figure that always renders: no currency present reads as zero in `fallback`. */
export function orZero(totals: MoneyTotals, fallback: Currency): MoneyTotals {
  return totals.length > 0 ? totals : [{ currency: fallback, cents: 0 }];
}

/** "€40.00", or "€40.00 and £12.00", or "€1.00, £2.00 and $3.00"; "" for none. */
export function formatTotals(totals: MoneyTotals): string {
  const parts = totals.map((t) => formatMoneyCents(t.cents, t.currency));
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
