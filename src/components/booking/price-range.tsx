import type { TierPrices } from '@/lib/tier-estimates';

interface PriceRangeProps {
  /** Estimated price per tier 1..5 if the class ran with today's sign-ups plus you. */
  estimates: TierPrices;
  className?: string;
}

// The public price line — tier 1 to tier 5 estimate with the income-tier
// disclaimer. Shared so the public teacher page's class list and the
// booking page never drift.
export function PriceRange({ estimates, className }: PriceRangeProps) {
  const low = Math.min(...estimates);
  const high = Math.max(...estimates);
  return (
    <p className={`type-caption ${className ?? ''}`.trim()}>
      Your price:{' '}
      <span className="type-number text-[13px]">
        &euro;{low.toFixed(2)} &ndash; &euro;{high.toFixed(2)}
      </span>{' '}
      depending on your income tier
    </p>
  );
}
