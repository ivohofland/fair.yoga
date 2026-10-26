'use client';

import { useState } from 'react';
import { normalSpread, emptyCounts, studentsIn, type TierCounts } from '@/lib/pricing-preview';
import { isIncomeTier } from '@/lib/tiers';
import { vatPercentViolation } from '@/lib/vat';
import { economicsViolations, type EconomicsRule } from '@/lib/class-economics';
import { ONLINE_SUBSIDY_COPY } from '@/lib/class-economics-copy';
import { PricingPreviewResult, type PricingPreviewInputs } from './pricing-preview-result';

/** The preview's own wording for each rule `economicsViolations` can report. */
const ECONOMICS_COPY = {
  students_order: 'Min students cannot exceed max students',
  rate_order: 'Min rate cannot exceed target rate',
  room_subsidy: 'Min rate cannot subsidize more than the room cost — prices would go negative',
} as const satisfies Record<EconomicsRule, string>;

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
  vatPercent,
  hideRoomCost = false,
}: PricingPreviewInputs) {
  const effectiveMin = Math.max(1, minStudents);
  const effectiveMax = Math.max(effectiveMin, maxStudents);
  // The whole-number range the preview prices: the slider, its captions and the table read it.
  const lowest = Math.ceil(effectiveMin);
  const highest = Math.max(lowest, Math.floor(effectiveMax));

  // The size the teacher chose on the slider. What is shown is this clamped to the range,
  // so a bound narrowed past it, even mid-typing, and widened again gives the choice back.
  const [chosenCount, setChosenCount] = useState(
    Math.round((effectiveMin + effectiveMax) / 2),
  );
  const [mode, setMode] = useState<'normal' | 'shuffle'>('normal');
  // The last shuffled mix, holding as many students as the size it was drawn for.
  const [shuffled, setShuffled] = useState<TierCounts>(emptyCounts);

  // A choice seeded while a bound was cleared is NaN; the range's midpoint stands in.
  const chosen = Number.isFinite(chosenCount) ? chosenCount : Math.round((lowest + highest) / 2);
  const shownCount = Math.min(highest, Math.max(lowest, chosen));

  function handleModeChange(newMode: 'normal' | 'shuffle') {
    setMode(newMode);
    if (newMode === 'shuffle') setShuffled(shuffleMix(shownCount));
  }

  if (![roomCost, minRate, targetRate].every(Number.isFinite)) {
    return (
      <p className="text-sm text-brown py-2">
        Enter valid amounts to see pricing preview.
      </p>
    );
  }

  // Before the rules: `<` and `>` against NaN are false, so a NaN count breaks none of
  // them and would reach the slider as "NaN students".
  if (![minStudents, maxStudents].every(Number.isFinite)) {
    return (
      <p className="text-sm text-brown py-2">
        Enter valid student counts to see pricing preview.
      </p>
    );
  }

  // A rule the economics break is named in place of the prices it would produce.
  const violations = economicsViolations({ roomCost, minRate, targetRate, minStudents, maxStudents });
  if (violations.length > 0) {
    return (
      <div className="py-2">
        {violations.map((v) => (
          <p key={v.rule} className="text-sm text-brown">
            {hideRoomCost && v.rule === 'room_subsidy' ? ONLINE_SUBSIDY_COPY : ECONOMICS_COPY[v.rule]}
          </p>
        ))}
      </div>
    );
  }

  // A VAT percentage no write path accepts is named in place of the prices it would produce.
  const vatViolation = vatPercentViolation(vatPercent);
  if (vatViolation !== null) {
    return <p className="text-sm text-brown py-2">{vatViolation}</p>;
  }

  // Past the gates `shownCount` is a finite whole number, so the redraw below settles in one
  // pass; above them a NaN size would never match its own draw and loop.
  if (mode === 'shuffle' && studentsIn(shuffled) !== shownCount) {
    // Adjusting state during render: React re-renders before committing, so a mix drawn for
    // another size never reaches the screen.
    setShuffled(shuffleMix(shownCount));
  }
  const distribution = mode === 'normal' ? normalSpread(shownCount) : shuffled;

  return (
    <div className="mt-6 flex flex-col gap-6">
      {/* Slider */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="type-label text-ink">Explore class size</span>
          <span className="type-caption tabular-nums">{shownCount} students</span>
        </div>
        <input
          type="range"
          min={lowest}
          max={highest}
          value={shownCount}
          onChange={(e) => setChosenCount(Number(e.target.value))}
          className="w-full accent-teal"
        />
        <div className="flex justify-between type-caption mt-1">
          <span>{lowest} min</span>
          <span>{highest} max</span>
        </div>
      </div>

      <PricingPreviewResult
        currency={currency}
        roomCost={roomCost}
        minRate={minRate}
        targetRate={targetRate}
        minStudents={lowest}
        maxStudents={highest}
        vatPercent={vatPercent}
        hideRoomCost={hideRoomCost}
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
