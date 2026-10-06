'use client';

import { useState, useCallback } from 'react';
import type { Currency } from '@prisma/client';
import { formatMoney } from '@/lib/format';
import { calculateEffectiveTeacherRate } from '@/services/pricing';
import { normalSpread, tierPrices, priceSpread } from '@/lib/pricing-preview';

interface PricingPreviewTableProps {
  currency: Currency;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
}

// ---------------------------------------------------------------------------
// Distribution logic
// ---------------------------------------------------------------------------

function shuffleMix(n: number): number[] {
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    // Box-Muller transform: N(μ=2, σ=1.2)
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = Math.round(2 + 1.2 * z);
    const clamped = Math.max(0, Math.min(4, value));
    counts[clamped]!++;
  }
  return counts;
}

const TIER_LABELS = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PricingPreviewTable({
  currency,
  roomCost,
  minRate,
  targetRate,
  minStudents,
  maxStudents,
}: PricingPreviewTableProps) {
  const effectiveMin = Math.max(1, minStudents);
  const effectiveMax = Math.max(effectiveMin, maxStudents);

  const [studentCount, setStudentCount] = useState(
    Math.round((effectiveMin + effectiveMax) / 2),
  );
  const [mode, setMode] = useState<'normal' | 'shuffle'>('normal');
  const [distribution, setDistribution] = useState<number[]>(() =>
    normalSpread(Math.round((effectiveMin + effectiveMax) / 2)),
  );

  const updateDistribution = useCallback(
    (count: number, newMode: 'normal' | 'shuffle') => {
      setDistribution(
        newMode === 'normal' ? normalSpread(count) : shuffleMix(count),
      );
    },
    [],
  );

  function handleSliderChange(value: number) {
    setStudentCount(value);
    updateDistribution(value, mode);
  }

  function handleModeChange(newMode: 'normal' | 'shuffle') {
    setMode(newMode);
    updateDistribution(studentCount, newMode);
  }

  if (effectiveMin <= 0 || effectiveMax <= 0 || effectiveMax < effectiveMin) {
    return (
      <p className="text-sm text-brown py-2">
        Enter valid student counts to see pricing preview.
      </p>
    );
  }

  const teacherRate = calculateEffectiveTeacherRate({
    studentCount,
    minStudents: effectiveMin,
    maxStudents: effectiveMax,
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
    <div className="mt-6 flex flex-col gap-6">
      {/* Slider */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="type-label text-ink">Explore class size</span>
          <span className="type-caption tabular-nums">{studentCount} students</span>
        </div>
        <input
          type="range"
          min={effectiveMin}
          max={effectiveMax}
          value={studentCount}
          onChange={(e) => handleSliderChange(Number(e.target.value))}
          className="w-full accent-teal"
        />
        <div className="flex justify-between type-caption mt-1">
          <span>{effectiveMin} min</span>
          <span>{effectiveMax} max</span>
        </div>
      </div>

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

        {/* Mode toggle */}
        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => handleModeChange('normal')}
            className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] ${
              mode === 'normal'
                ? 'border-teal text-teal bg-teal-tint'
                : 'border-border text-brown'
            }`}
          >
            Normal spread
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('shuffle')}
            className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] ${
              mode === 'shuffle'
                ? 'border-teal text-teal bg-teal-tint'
                : 'border-border text-brown'
            }`}
          >
            Shuffle mix
          </button>
        </div>

        {/* Tier table — teal caption headers, tabular prices on the decimal */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between py-2 border-b border-border text-[12px] font-medium text-teal">
            <span className="flex-1">TIER</span>
            <span className="w-20 text-right">STUDENTS</span>
            <span className="w-20 text-right">PRICE</span>
          </div>
          {TIER_LABELS.map((label, i) => {
            const count = distribution[i]!;
            const isActive = count > 0;
            return (
              <div
                key={label}
                className={`flex items-center justify-between min-h-12 py-2 border-b border-border last:border-b-0 ${
                  isActive ? '' : 'opacity-40'
                }`}
              >
                <span className="flex-1 text-base text-ink">{label}</span>
                <span className="w-20 text-right text-sm text-brown tabular-nums">{count}</span>
                <span className="w-20 text-right type-number text-sm">
                  {formatMoney(prices[i]!, currency)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Spread line — show the math */}
        {spread && (
          <div className="mt-4 text-center">
            <span className="type-caption">
              Highest pays {spread}&times; the lowest
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
