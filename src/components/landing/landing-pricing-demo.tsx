'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { PricingPreviewResult } from '@/components/class/pricing-preview-result';
import { formatEuro } from '@/lib/format';
import { normalSpread } from '@/lib/pricing-preview';

/** The example class a visitor explores, as a teacher would configure it. */
const EXAMPLE = { roomCost: 20, minRate: 40, minStudents: 4, maxStudents: 12 } as const;

const FEWEST_STUDENTS = 2;
const RATE_RANGE = { min: 50, max: 130, step: 5 } as const;

export function LandingPricingDemo() {
  const [studentCount, setStudentCount] = useState(7);
  const [targetRate, setTargetRate] = useState(90);
  const goesAhead = studentCount >= EXAMPLE.minStudents;

  return (
    <Card>
      <p className="type-caption mb-5">
        Example class: room {formatEuro(EXAMPLE.roomCost)} · minimum rate{' '}
        {formatEuro(EXAMPLE.minRate)} at {EXAMPLE.minStudents} students · your target at{' '}
        {EXAMPLE.maxStudents}
      </p>

      <div className="flex flex-col gap-6">
        <div>
          <label htmlFor="demo-students" className="type-label text-ink">
            Students registered
          </label>
          <RegistrationProgress
            registered={studentCount}
            min={EXAMPLE.minStudents}
            max={EXAMPLE.maxStudents}
          />
          <input
            id="demo-students"
            type="range"
            min={FEWEST_STUDENTS}
            max={EXAMPLE.maxStudents}
            step={1}
            value={studentCount}
            aria-valuetext={`${studentCount} students`}
            onChange={(e) => setStudentCount(Number(e.target.value))}
            className="w-full accent-teal mt-3"
          />
          {/* Mounted empty so screen readers announce the message when it fills */}
          <p role="status" className={`type-body text-danger ${goesAhead ? '' : 'mt-4'}`.trim()}>
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
            <span className="type-number text-base">{formatEuro(targetRate)}</span>
          </div>
          <input
            id="demo-rate"
            type="range"
            min={RATE_RANGE.min}
            max={RATE_RANGE.max}
            step={RATE_RANGE.step}
            value={targetRate}
            aria-valuetext={formatEuro(targetRate)}
            onChange={(e) => setTargetRate(Number(e.target.value))}
            className="w-full accent-teal mt-2"
          />
          <p className="type-caption mt-1">What you earn with a full class of {EXAMPLE.maxStudents}</p>
        </div>

        {goesAhead && (
          <PricingPreviewResult
            {...EXAMPLE}
            targetRate={targetRate}
            studentCount={studentCount}
            distribution={normalSpread(studentCount)}
          />
        )}
      </div>
    </Card>
  );
}
