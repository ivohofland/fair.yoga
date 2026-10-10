'use client';

import { useState } from 'react';
import {
  PricingPreviewResult,
  type PricingPreviewInputs,
} from '@/components/class/pricing-preview-result';
import { formatMoney } from '@/lib/format';
import { normalSpread } from '@/lib/pricing-preview';
import { RangeTrack } from './range-track';

/** The example class a visitor explores, as a teacher would configure it. */
const EXAMPLE = {
  currency: 'EUR',
  roomCost: 20,
  minRate: 40,
  minStudents: 4,
  maxStudents: 12,
} as const satisfies Omit<PricingPreviewInputs, 'targetRate'>;

const FEWEST_STUDENTS = 2;
const RATE_RANGE = { min: 50, max: 130, step: 5 } as const;

export function LandingPricingDemo() {
  const [studentCount, setStudentCount] = useState(7);
  const [targetRate, setTargetRate] = useState(90);
  const goesAhead = studentCount >= EXAMPLE.minStudents;

  return (
    // Captions darken to brown: brown-light falls short of 4.5:1 on this deeper sand
    <div className="bg-sand border border-border rounded-card p-6 flex flex-col gap-6 [&_.type-caption]:text-brown">
      <p className="type-caption">
        Example: a room that costs {formatMoney(EXAMPLE.roomCost, EXAMPLE.currency)}, a minimum of{' '}
        {formatMoney(EXAMPLE.minRate, EXAMPLE.currency)} from {EXAMPLE.minStudents} students, and your
        target reached at {EXAMPLE.maxStudents}.
      </p>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="demo-students" className="type-label text-ink">
            Students registered
          </label>
          <span className="flex items-baseline gap-[5px] tabular-nums">
            <span className={`text-lg font-semibold ${goesAhead ? 'text-teal' : 'text-danger'}`}>
              {studentCount}
            </span>
            <span className="text-sm text-brown">
              / {EXAMPLE.minStudents}–{EXAMPLE.maxStudents}
            </span>
          </span>
        </div>
        <RangeTrack
          id="demo-students"
          min={FEWEST_STUDENTS}
          max={EXAMPLE.maxStudents}
          step={1}
          value={studentCount}
          tick={EXAMPLE.minStudents}
          fillClass={goesAhead ? 'bg-teal' : 'bg-danger'}
          aria-valuetext={`${studentCount} students`}
          onChange={(e) => setStudentCount(Number(e.target.value))}
        />
        {/* Mounted empty so screen readers announce the message when it fills */}
        <p role="status" className={`type-body text-danger ${goesAhead ? '' : 'mt-2'}`.trim()}>
          {goesAhead
            ? null
            : `This class needs ${EXAMPLE.minStudents} students to go ahead. If it doesn’t get there, it’s cancelled and nobody pays.`}
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="demo-rate" className="type-label text-ink">
            Your target rate
          </label>
          <span className="type-number text-base">{formatMoney(targetRate, EXAMPLE.currency)}</span>
        </div>
        <RangeTrack
          id="demo-rate"
          min={RATE_RANGE.min}
          max={RATE_RANGE.max}
          step={RATE_RANGE.step}
          value={targetRate}
          fillClass="bg-teal"
          aria-valuetext={formatMoney(targetRate, EXAMPLE.currency)}
          onChange={(e) => setTargetRate(Number(e.target.value))}
        />
        <p className="type-caption">What you earn with a full class of {EXAMPLE.maxStudents}</p>
      </div>

      {goesAhead && (
        <PricingPreviewResult
          {...EXAMPLE}
          targetRate={targetRate}
          distribution={normalSpread(studentCount)}
          showRateProgress={false}
        />
      )}
    </div>
  );
}
