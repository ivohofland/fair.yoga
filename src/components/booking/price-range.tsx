interface PriceRangeProps {
  /** Estimated price per tier 1..5 if the class ran with today's sign-ups plus you. */
  estimates: number[];
  className?: string;
}

// The public price line — tier 1 to tier 5 estimate with the income-tier
// disclaimer. Shared so the schedule overview and booking page never drift.
export function PriceRange({ estimates, className }: PriceRangeProps) {
  const low = Math.min(...estimates);
  const high = Math.max(...estimates);
  return (
    <p className={`type-caption ${className ?? ''}`}>
      Your price:{' '}
      <span className="type-number text-[13px]">
        &euro;{low.toFixed(2)} &ndash; &euro;{high.toFixed(2)}
      </span>{' '}
      depending on your income tier
    </p>
  );
}
