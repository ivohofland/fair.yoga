export const PRICING_EXPLANATION =
  'Prices are income-based: everyone in the room pays what fits their situation, and the final price settles after class based on who came. The highest tier never pays more than about twice the lowest.';

interface PricingExplainerProps {
  /** Margin/width for placement only — never override the card's own background or padding. */
  className?: string;
  id?: string;
}

/**
 * The income-based pricing promise card (#432).
 */
export function PricingExplainer({ className = '', id }: PricingExplainerProps) {
  return (
    <div id={id} className={`bg-teal-tint rounded-card p-5 ${className}`.trim()}>
      <p className="type-caption">{PRICING_EXPLANATION}</p>
    </div>
  );
}
