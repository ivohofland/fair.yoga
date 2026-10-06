import { describe, it, expect } from 'vitest';
import { Currency, Prisma } from '@prisma/client';
import { CURRENCY_PREFIX } from './format';
import { totalsByCurrency, formatTotals, orZero } from './money-totals';

describe('CURRENCY_PREFIX key order', () => {
  // `totalsByCurrency` orders by these keys. `satisfies` checks which keys
  // exist, not their order, so this is what holds the order to the enum's.
  it('is the Currency declaration order', () => {
    expect(Object.keys(CURRENCY_PREFIX)).toEqual(Object.values(Currency));
  });
});

describe('totalsByCurrency', () => {
  it('sums per currency in cents without float drift', () => {
    expect(
      totalsByCurrency(
        [
          { currency: 'EUR', amount: 0.1 },
          { currency: 'EUR', amount: new Prisma.Decimal('0.20') },
          { currency: 'GBP', amount: 12 },
        ],
        'EUR',
      ),
    ).toEqual([
      { currency: 'EUR', cents: 30 },
      { currency: 'GBP', cents: 1200 },
    ]);
  });

  it('puts first before the rest, which follow declaration order', () => {
    const items = [
      { currency: 'USD' as const, amount: 3 },
      { currency: 'EUR' as const, amount: 1 },
      { currency: 'GBP' as const, amount: 2 },
    ];
    expect(totalsByCurrency(items, 'GBP').map((t) => t.currency)).toEqual(['GBP', 'EUR', 'USD']);
    expect(totalsByCurrency(items, 'EUR').map((t) => t.currency)).toEqual(['EUR', 'GBP', 'USD']);
  });

  it('omits currencies with no items, including first', () => {
    expect(totalsByCurrency([{ currency: 'USD', amount: 1 }], 'EUR')).toEqual([{ currency: 'USD', cents: 100 }]);
    expect(totalsByCurrency([], 'EUR')).toEqual([]);
  });
});

describe('formatTotals', () => {
  it('reads empty, one, two and three', () => {
    expect(formatTotals([])).toBe('');
    expect(formatTotals([{ currency: 'EUR', cents: 4000 }])).toBe('€40.00');
    expect(formatTotals([{ currency: 'EUR', cents: 4000 }, { currency: 'GBP', cents: 1200 }])).toBe('€40.00 and £12.00');
    expect(
      formatTotals([{ currency: 'EUR', cents: 100 }, { currency: 'GBP', cents: 200 }, { currency: 'USD', cents: 300 }]),
    ).toBe('€1.00, £2.00 and $3.00');
  });
});

describe('orZero', () => {
  it('keeps totals, or stands a zero in the fallback currency', () => {
    expect(orZero([], 'GBP')).toEqual([{ currency: 'GBP', cents: 0 }]);
    expect(orZero([{ currency: 'EUR', cents: 5 }], 'GBP')).toEqual([{ currency: 'EUR', cents: 5 }]);
  });
});
