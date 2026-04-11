import type { Class } from '@prisma/client';

interface TierPrice {
  tier: number;
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
  const tierSummary: { tier: number; price: number; count: number }[] = [];
  for (let tier = 1; tier <= 5; tier++) {
    const entries = tierPrices.filter((tp) => tp.tier === tier);
    if (entries.length > 0) {
      tierSummary.push({ tier, price: entries[0]!.price, count: entries.length });
    }
  }

  return (
    <div className="py-6">
      <h2 className="font-heading text-lg font-bold text-dark mb-4">
        Pricing Breakdown
      </h2>

      {/* Teacher earnings — most prominent */}
      <div className="py-4 border-b border-border">
        <span className="text-sm text-brown">Your earnings</span>
        <p className="font-heading text-3xl font-bold text-teal mt-1">
          &euro;{teacherEarnings.toFixed(2)}
        </p>
      </div>

      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Room cost</span>
        <span className="text-dark">&euro;{roomCost.toFixed(2)}</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Students charged</span>
        <span className="text-dark">{totalStudents}</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Rate</span>
        <span className="text-dark">&euro;{Number(cls.minRate).toFixed(2)} &ndash; &euro;{Number(cls.targetRate).toFixed(2)}</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Total revenue</span>
        <span className="text-dark font-semibold">
          &euro;{totalRevenue.toFixed(2)}
        </span>
      </div>

      {/* Price per tier */}
      {tierSummary.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm text-brown mb-2">Price per tier</h3>
          {tierSummary.map((row) => (
            <div key={row.tier} className="flex justify-between py-2 border-b border-border text-sm">
              <span className="text-dark">
                Tier {row.tier}
                <span className="text-brown text-xs ml-1">({row.count})</span>
              </span>
              <span className="font-semibold text-teal">
                &euro;{row.price.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
