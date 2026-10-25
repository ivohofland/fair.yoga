import type { ReactNode } from 'react';
import type { Currency } from '@/lib/prisma-client';
import { formatMoney } from '@/lib/format';
import { TIER_INFO } from '@/lib/tiers';
import { tierPrices, priceSpread, studentsIn, type TierCounts } from '@/lib/pricing-preview';
import { vatThousandths, withVat } from '@/lib/vat';
import { calculateEffectiveTeacherRate } from '@/services/pricing';

export interface PricingPreviewInputs {
  currency: Currency;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** The VAT percentage the class charges on top of room and rate; 0 charges none. */
  vatPercent: number;
  /** An online class has no room: its cost line is left out. */
  hideRoomCost?: boolean;
}

interface PricingPreviewResultProps extends PricingPreviewInputs {
  /** The class being previewed; its size sets the teacher's rate. */
  distribution: TierCounts;
  /** Rendered between "What students pay" and the tier rows. */
  distributionControl?: ReactNode;
  /** Where the rate sits between minimum and target; meaningless to a reader who set neither. */
  showRateProgress?: boolean;
}

/** What the class in `distribution` earns the teacher and costs each tier. */
export function PricingPreviewResult({
  currency,
  roomCost,
  minRate,
  targetRate,
  minStudents,
  maxStudents,
  vatPercent,
  hideRoomCost = false,
  distribution,
  distributionControl,
  showRateProgress = true,
}: PricingPreviewResultProps) {
  const teacherRate = calculateEffectiveTeacherRate({
    studentCount: studentsIn(distribution),
    minStudents,
    maxStudents,
    minRate,
    targetRate,
  });

  const thousandths = vatThousandths(vatPercent);
  const chargesVat = thousandths > 0;
  const baseCost = roomCost + teacherRate;
  // The engine's own total, rounded to cents once; the VAT line is what that
  // total adds to the rounded base, so the lines shown add up to it.
  const totalCents = chargesVat ? Math.round(withVat(baseCost, thousandths) * 100) : 0;
  const vatCents = totalCents - Math.round(baseCost * 100);
  const totalCost = chargesVat ? totalCents / 100 : baseCost;
  const rateRange = targetRate - minRate;
  const rateProgress =
    rateRange === 0 ? 100 : Math.round(((teacherRate - minRate) / rateRange) * 100);

  const prices = tierPrices(withVat(baseCost, thousandths), distribution);
  const spread = priceSpread(prices, distribution);

  return (
    <>
      {/* You earn card */}
      <div className="bg-teal-tint rounded-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="type-label">{chargesVat ? 'You earn (excl. VAT)' : 'You earn'}</p>
            <p className="type-caption">total for this class</p>
          </div>
          <p className="type-number text-[28px] leading-[1.25]">{formatMoney(teacherRate, currency)}</p>
        </div>
        <div className="flex gap-6">
          {!hideRoomCost && (
            <div>
              <p className="type-caption">{chargesVat ? 'Room cost (excl. VAT)' : 'Room cost'}</p>
              <p className="text-sm font-medium text-ink tabular-nums">{formatMoney(roomCost, currency)}</p>
            </div>
          )}
          {chargesVat && (
            <div>
              <p className="type-caption">{`VAT (${vatPercent}%)`}</p>
              <p className="text-sm font-medium text-ink tabular-nums">{formatMoney(vatCents / 100, currency)}</p>
            </div>
          )}
          <div>
            <p className="type-caption">Total class cost</p>
            <p className="text-sm font-medium text-ink tabular-nums">{formatMoney(totalCost, currency)}</p>
          </div>
          {showRateProgress && (
            <div>
              <p className="type-caption">Rate progress</p>
              <p className="text-sm font-medium text-ink tabular-nums">{rateProgress}%</p>
            </div>
          )}
        </div>
      </div>

      {/* What students pay */}
      <div>
        <p className="type-label text-ink mb-3">
          {chargesVat ? 'What students pay (incl. VAT)' : 'What students pay'}
        </p>

        {distributionControl}

        {/* Tier table — teal caption headers, tabular prices on the decimal */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between py-2 border-b border-border text-[12px] font-medium text-teal">
            <span className="flex-1">TIER</span>
            <span className="w-20 text-right">STUDENTS</span>
            <span className="w-20 text-right">PRICE</span>
          </div>
          {TIER_INFO.map((info) => {
            const count = distribution[info.tier];
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
                  {formatMoney(prices[info.tier], currency)}
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
