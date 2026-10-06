import type { ReactNode } from 'react';
import type { Currency } from '@prisma/client';
import { formatMoney } from '@/lib/format';
import { TIER_INFO } from '@/lib/tiers';
import { tierPrices, priceSpread } from '@/lib/pricing-preview';
import { calculateEffectiveTeacherRate } from '@/services/pricing';

export interface PricingPreviewInputs {
  currency: Currency;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
}

interface PricingPreviewResultProps extends PricingPreviewInputs {
  studentCount: number;
  /** Students per tier, `TIER_INFO` order. */
  distribution: readonly number[];
  /** Rendered between "What students pay" and the tier rows. */
  distributionControl?: ReactNode;
}

/** What a class of `studentCount` earns the teacher and costs each tier. */
export function PricingPreviewResult({
  currency,
  roomCost,
  minRate,
  targetRate,
  minStudents,
  maxStudents,
  studentCount,
  distribution,
  distributionControl,
}: PricingPreviewResultProps) {
  const teacherRate = calculateEffectiveTeacherRate({
    studentCount,
    minStudents,
    maxStudents,
    minRate,
    targetRate,
  });

  const totalCost = roomCost + teacherRate;
  const rateRange = targetRate - minRate;
  const rateProgress =
    rateRange === 0 ? 100 : Math.round(((teacherRate - minRate) / rateRange) * 100);

  const prices = tierPrices(totalCost, distribution);
  const spread = priceSpread(prices, distribution);

  return (
    <>
      {/* You earn card */}
      <div className="bg-teal-tint rounded-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="type-label">You earn</p>
            <p className="type-caption">total for this class</p>
          </div>
          <p className="type-number text-[28px] leading-[1.25]">{formatMoney(teacherRate, currency)}</p>
        </div>
        <div className="flex gap-6">
          <div>
            <p className="type-caption">Room cost</p>
            <p className="text-sm font-medium text-ink tabular-nums">{formatMoney(roomCost, currency)}</p>
          </div>
          <div>
            <p className="type-caption">Total class cost</p>
            <p className="text-sm font-medium text-ink tabular-nums">{formatMoney(totalCost, currency)}</p>
          </div>
          <div>
            <p className="type-caption">Rate progress</p>
            <p className="text-sm font-medium text-ink tabular-nums">{rateProgress}%</p>
          </div>
        </div>
      </div>

      {/* What students pay */}
      <div>
        <p className="type-label text-ink mb-3">What students pay</p>

        {distributionControl}

        {/* Tier table — teal caption headers, tabular prices on the decimal */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between py-2 border-b border-border text-[12px] font-medium text-teal">
            <span className="flex-1">TIER</span>
            <span className="w-20 text-right">STUDENTS</span>
            <span className="w-20 text-right">PRICE</span>
          </div>
          {TIER_INFO.map((info, i) => {
            const count = distribution[i] ?? 0;
            return (
              <div
                key={info.tier}
                className={`flex items-center justify-between min-h-12 py-2 border-b border-border last:border-b-0 ${
                  count > 0 ? '' : 'opacity-40'
                }`}
              >
                <span className="flex-1 text-base text-ink">{`${info.tier} · ${info.label}`}</span>
                <span className="w-20 text-right text-sm text-brown tabular-nums">{count}</span>
                <span className="w-20 text-right type-number text-sm">
                  {formatMoney(prices[i] ?? 0, currency)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Spread line — show the math */}
        {spread && (
          <div className="mt-4 text-center">
            <span className="type-caption">Highest pays {spread}&times; the lowest</span>
          </div>
        )}
      </div>
    </>
  );
}
