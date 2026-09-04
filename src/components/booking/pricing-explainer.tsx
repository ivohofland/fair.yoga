export const PRICING_EXPLANATION =
  'Prices are income-based: everyone in the room pays what fits their situation, and the final price settles after class based on who came. The highest tier never pays more than about twice the lowest.';

interface PricingExplainerProps {
  className?: string;
}

/**
 * The income-based pricing promise card (#432).
 * Used on the public schedule overview (static card above classes) and in the
 * booking flow (interactive disclosure triggered by "Learn more").
 */
export function PricingExplainer({ className = '' }: PricingExplainerProps) {
  return (
    <div className={`bg-teal-tint rounded-card p-5 ${className}`.trim()}>
      <p className="type-caption">{PRICING_EXPLANATION}</p>
    </div>
  );
}
