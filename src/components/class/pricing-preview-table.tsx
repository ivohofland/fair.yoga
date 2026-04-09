'use client';

import { useState, useCallback } from 'react';
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

// ---------------------------------------------------------------------------
// Distribution logic
// ---------------------------------------------------------------------------

const NORMAL_WEIGHTS = [0.0895, 0.2242, 0.3726, 0.2242, 0.0895];

function normalSpread(n: number): number[] {
  const raw = NORMAL_WEIGHTS.map((w) => w * n);
  const floored = raw.map(Math.floor);
  let remaining = n - floored.reduce((a, b) => a + b, 0);

  // Distribute remainders to tiers with largest fractional parts (center-first tiebreak)
  const fractions = raw.map((v, i) => ({ i, frac: v - floored[i]! }));
  fractions.sort((a, b) => {
    if (b.frac !== a.frac) return b.frac - a.frac;
    // Center-first tiebreak: closer to index 2 wins
    return Math.abs(a.i - 2) - Math.abs(b.i - 2);
  });

  for (const { i } of fractions) {
    if (remaining <= 0) break;
    floored[i]!++;
    remaining--;
  }

  return floored;
}

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

// ---------------------------------------------------------------------------
// Pricing calculation
// ---------------------------------------------------------------------------

const TIER_RATIO_VALUES = [
  TIER_RATIOS[1]!,
  TIER_RATIOS[2]!,
  TIER_RATIOS[3]!,
  TIER_RATIOS[4]!,
  TIER_RATIOS[5]!,
];

function calculateTierPrices(
  total: number,
  distribution: number[],
): { prices: number[]; weightedSum: number } {
  const weightedSum = distribution.reduce(
    (sum, count, i) => sum + count * TIER_RATIO_VALUES[i]!,
    0,
  );

  if (weightedSum === 0) {
    return { prices: [0, 0, 0, 0, 0], weightedSum: 0 };
  }

  const prices = TIER_RATIO_VALUES.map(
    (ratio) => Math.round(((total / weightedSum) * ratio) * 100) / 100,
  );

  return { prices, weightedSum };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatEuro(amount: number): string {
  return `\u20AC${amount.toFixed(2)}`;
}

const TIER_LABELS = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5'];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PricingPreviewTable({
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

  const { prices } = calculateTierPrices(totalCost, distribution);

  // Spread: ratio of highest to lowest active tier price
  const activePrices = prices.filter((_, i) => distribution[i]! > 0);
  const spread =
    activePrices.length >= 2
      ? (Math.max(...activePrices) / Math.min(...activePrices)).toFixed(1)
      : null;

  return (
    <div className="mt-6 flex flex-col gap-6">
      {/* Slider */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-dark">Explore class size</span>
          <span className="text-sm text-brown">{studentCount} students</span>
        </div>
        <input
          type="range"
          min={effectiveMin}
          max={effectiveMax}
          value={studentCount}
          onChange={(e) => handleSliderChange(Number(e.target.value))}
          className="w-full accent-teal"
        />
        <div className="flex justify-between text-xs text-brown mt-1">
          <span>{effectiveMin} min</span>
          <span>{effectiveMax} max</span>
        </div>
      </div>

      {/* You earn card */}
      <div className="bg-teal/10 p-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs text-brown">You earn</p>
            <p className="text-xs text-brown">total for this class</p>
          </div>
          <p className="text-2xl font-bold text-teal">{formatEuro(teacherRate)}</p>
        </div>
        <div className="flex gap-6">
          <div>
            <p className="text-xs text-brown">Room cost</p>
            <p className="text-sm font-medium text-dark">{formatEuro(roomCost)}</p>
          </div>
          <div>
            <p className="text-xs text-brown">Total class cost</p>
            <p className="text-sm font-medium text-dark">{formatEuro(totalCost)}</p>
          </div>
          <div>
            <p className="text-xs text-brown">Rate progress</p>
            <p className="text-sm font-medium text-dark">{rateProgress}%</p>
          </div>
        </div>
      </div>

      {/* What students pay */}
      <div>
        <p className="text-sm font-medium text-dark mb-3">What students pay</p>

        {/* Mode toggle */}
        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            onClick={() => handleModeChange('normal')}
            className={`px-3 py-2 text-sm border ${
              mode === 'normal'
                ? 'border-teal text-teal'
                : 'border-border text-brown'
            }`}
          >
            Normal spread
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('shuffle')}
            className={`px-3 py-2 text-sm border ${
              mode === 'shuffle'
                ? 'border-teal text-teal'
                : 'border-border text-brown'
            }`}
          >
            Shuffle mix
          </button>
        </div>

        {/* Tier table */}
        <div className="flex flex-col">
          <div className="flex items-center justify-between py-2 border-b border-border text-xs text-brown">
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
                className={`flex items-center justify-between py-3 border-b border-border ${
                  isActive ? '' : 'opacity-40'
                }`}
              >
                <span className="flex-1 flex items-center gap-2 text-sm text-dark">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: isActive ? '#1A5653' : '#D4C9B8' }}
                  />
                  {label}
                </span>
                <span className="w-20 text-right text-sm text-brown">{count}</span>
                <span className="w-20 text-right text-sm font-medium text-teal">
                  {formatEuro(prices[i]!)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Spread badge */}
        {spread && (
          <div className="mt-4 text-center">
            <span className="text-sm text-brown">
              Highest pays {spread}&times; the lowest
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
