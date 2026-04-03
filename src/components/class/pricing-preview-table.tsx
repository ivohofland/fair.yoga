'use client';

import {
  calculateEffectiveTeacherRate,
  TIER_RATIOS,
} from '@/services/pricing';

interface PricingPreviewTableProps {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
}

interface TierPrice {
  tier: number;
  ratio: number;
  price: number;
}

function previewPrices(
  roomCost: number,
  minRate: number,
  targetRate: number,
  minStudents: number,
  maxStudents: number,
  studentCount: number,
): TierPrice[] {
  if (studentCount <= 0) return [];

  const rate = calculateEffectiveTeacherRate({
    studentCount,
    minStudents,
    maxStudents,
    minRate,
    targetRate,
  });

  const total = roomCost + rate * studentCount;
  const avgPrice = total / studentCount;

  return Object.entries(TIER_RATIOS).map(([tier, ratio]) => ({
    tier: Number(tier),
    ratio,
    price: Math.round(avgPrice * ratio * 100) / 100,
  }));
}

function formatEuro(amount: number): string {
  return `\u20AC${amount.toFixed(2)}`;
}

export function PricingPreviewTable({
  roomCost,
  minRate,
  targetRate,
  minStudents,
  maxStudents,
}: PricingPreviewTableProps) {
  if (minStudents <= 0 || maxStudents <= 0 || maxStudents < minStudents) {
    return (
      <p className="text-sm text-brown py-2">
        Enter valid student counts to see pricing preview.
      </p>
    );
  }

  const midpoint = Math.round((minStudents + maxStudents) / 2);
  const scenarios = [
    { label: `At ${minStudents}`, count: minStudents },
    { label: `At ${midpoint}`, count: midpoint },
    { label: `At ${maxStudents}`, count: maxStudents },
  ];

  const scenarioData = scenarios.map((s) => ({
    ...s,
    prices: previewPrices(roomCost, minRate, targetRate, minStudents, maxStudents, s.count),
    teacherRate: calculateEffectiveTeacherRate({
      studentCount: s.count,
      minStudents,
      maxStudents,
      minRate,
      targetRate,
    }),
  }));

  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-dark mb-2">Pricing preview</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-2 pr-4 text-brown font-normal">Tier</th>
              {scenarioData.map((s) => (
                <th key={s.count} className="text-right py-2 px-2 text-brown font-normal">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5].map((tier) => (
              <tr key={tier} className="border-b border-border">
                <td className="py-2 pr-4 text-brown">
                  Tier {tier} ({TIER_RATIOS[tier]}&times;)
                </td>
                {scenarioData.map((s) => {
                  const tierPrice = s.prices.find((p) => p.tier === tier);
                  return (
                    <td key={s.count} className="text-right py-2 px-2 font-semibold text-teal">
                      {tierPrice ? formatEuro(tierPrice.price) : '-'}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td className="py-2 pr-4 text-brown font-medium">Teacher rate</td>
              {scenarioData.map((s) => (
                <td key={s.count} className="text-right py-2 px-2 font-semibold text-teal">
                  {formatEuro(s.teacherRate)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
