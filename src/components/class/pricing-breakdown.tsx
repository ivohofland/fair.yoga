import type { Class } from '@prisma/client';
import { INCOME_TIERS, type IncomeTier } from '@/lib/tiers';

interface TierPrice {
  tier: IncomeTier;
  price: number;
}

interface PricingBreakdownProps {
  cls: Class;
  tierPrices: TierPrice[];
}

export function PricingBreakdown({ cls, tierPrices }: PricingBreakdownProps) {
  const totalRevenue = cls.totalRevenue ? Number(cls.totalRevenue) : 0;
  const roomCost = Number(cls.roomCost);
  const teacherEarnings = totalRevenue - roomCost;
  const totalStudents = cls.totalStudents ?? 0;

  // Group by tier, using the actual stored price
  const tierSummary: { tier: IncomeTier; price: number; count: number }[] = [];
  for (const tier of INCOME_TIERS) {
    const entries = tierPrices.filter((tp) => tp.tier === tier);
    const first = entries[0];
    if (first) {
      tierSummary.push({ tier, price: first.price, count: entries.length });
    }
  }

  return (
    <div className="py-6">
      <h2 className="type-subtitle mb-4">Pricing breakdown</h2>

      {/* Teacher earnings — the payoff, Display-size sans semibold teal */}
      <div className="bg-teal-tint rounded-card p-5 text-center">
        <span className="type-label">Your earnings</span>
        <p className="type-number text-[28px] leading-[1.25] mt-1">
          &euro;{teacherEarnings.toFixed(2)}
        </p>
      </div>

      <div className="mt-4">
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Room cost</span>
          <span className="tabular-nums text-brown">&euro;{roomCost.toFixed(2)}</span>
        </div>
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Students charged</span>
          <span className="tabular-nums text-ink">{totalStudents}</span>
        </div>
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Rate</span>
          <span className="tabular-nums text-ink">
            &euro;{Number(cls.minRate).toFixed(2)} &ndash; &euro;{Number(cls.targetRate).toFixed(2)}
          </span>
        </div>
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Total revenue</span>
          <span className="type-number">&euro;{totalRevenue.toFixed(2)}</span>
        </div>
      </div>

      {/* Price per tier */}
      {tierSummary.length > 0 && (
        <div className="mt-5">
          <h3 className="type-label mb-1">Price per tier</h3>
          {tierSummary.map((row) => (
            <div key={row.tier} className="flex justify-between items-center min-h-12 py-2 border-b border-border last:border-b-0">
              <span className="type-body">
                Tier {row.tier}
                <span className="type-caption ml-1.5">{row.count} {row.count === 1 ? 'student' : 'students'}</span>
              </span>
              <span className="type-number">&euro;{row.price.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
