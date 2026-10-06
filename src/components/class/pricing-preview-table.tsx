'use client';

import { useState, useCallback } from 'react';
import { normalSpread, emptyCounts, type TierCounts } from '@/lib/pricing-preview';
import { isIncomeTier } from '@/lib/tiers';
import { PricingPreviewResult, type PricingPreviewInputs } from './pricing-preview-result';

// ---------------------------------------------------------------------------
// Distribution logic
// ---------------------------------------------------------------------------

function shuffleMix(n: number): TierCounts {
  const counts = emptyCounts();
  for (let i = 0; i < n; i++) {
    // Box-Muller transform: N(μ=3, σ=1.2) on the tier scale
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const tier = Math.max(1, Math.min(5, Math.round(3 + 1.2 * z)));
    if (isIncomeTier(tier)) counts[tier]++;
  }
  return counts;
}

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
}: PricingPreviewInputs) {
  const effectiveMin = Math.max(1, minStudents);
  const effectiveMax = Math.max(effectiveMin, maxStudents);

  const [studentCount, setStudentCount] = useState(
    Math.round((effectiveMin + effectiveMax) / 2),
  );
  const [mode, setMode] = useState<'normal' | 'shuffle'>('normal');
  const [distribution, setDistribution] = useState<TierCounts>(() =>
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

      <PricingPreviewResult
        currency={currency}
        roomCost={roomCost}
        minRate={minRate}
        targetRate={targetRate}
        minStudents={effectiveMin}
        maxStudents={effectiveMax}
        distribution={distribution}
        distributionControl={
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
        }
      />
    </div>
  );
}
