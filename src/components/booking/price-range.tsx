import type { TierPrices, AttendanceSpread } from '@/lib/tier-estimates';
import type { PriceLineResult } from '@/lib/price-line';

interface PriceRangeProps {
  /** Estimated price per tier 1..5 if the class ran with today's sign-ups plus you. */
  estimates: TierPrices;
  className?: string;
}

// The public price line — tier 1 to tier 5 estimate with the income-tier
// disclaimer. Rendered via `ClassPriceLine` below, never imported directly
// by a page.
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

interface PersonalPriceRangeProps {
  spread: AttendanceSpread;
  className?: string;
}

// The known-tier variant: the tier question is settled, turnout is the
// uncertainty that remains. Same typography as PriceRange — the two
// lines must not drift apart.
export function PersonalPriceRange({ spread, className }: PersonalPriceRangeProps) {
  return (
    <p className={`type-caption ${className ?? ''}`.trim()}>
      Your price:{' '}
      <span className="type-number text-[13px]">
        &euro;{spread.low.toFixed(2)} &ndash; &euro;{spread.high.toFixed(2)}
      </span>{' '}
      depending on how many join
    </p>
  );
}

interface ClassPriceLineProps {
  line: PriceLineResult;
  className?: string;
}

// Renders whichever variant resolvePriceLine picked — the one place that
// switches on `line.kind`, so no page duplicates the branch.
export function ClassPriceLine({ line, className }: ClassPriceLineProps) {
  return line.kind === 'personal'
    ? <PersonalPriceRange spread={line.spread} className={className} />
    : <PriceRange estimates={line.estimates} className={className} />;
}
