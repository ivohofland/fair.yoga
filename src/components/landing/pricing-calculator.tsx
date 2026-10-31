'use client';

import { useId, useState, type ReactNode } from 'react';
import { PricingPreviewResult } from '@/components/class/pricing-preview-result';
import { formatMoney } from '@/lib/format';
import { PRICING_EXAMPLES, type PricingExample, type PricingExampleKey } from '@/lib/pricing-examples';
import { normalSpread } from '@/lib/pricing-preview';
import { RangeTrack } from './range-track';

const EXAMPLE_KEYS = Object.keys(PRICING_EXAMPLES) as PricingExampleKey[];
const VAT_CHOICES = [
  { percent: 0, label: 'None' },
  { percent: 9, label: '9%' },
  { percent: 21, label: '21%' },
] as const;

const STUDENTS = { min: 1, max: 18 } as const;
const ROOM = { min: 0, max: 80, step: 5 } as const;
const MINIMUM = { min: -20, max: 120, step: 5 } as const;
const TARGET = { min: 0, max: 150, step: 5 } as const;

/** What a visitor can change; the class size stays the example's. */
interface Adjustable {
  students: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  vatPercent: number;
}

function adjustableOf(example: PricingExample): Adjustable {
  return {
    students: example.students,
    roomCost: example.roomCost,
    minRate: example.minRate,
    targetRate: example.targetRate,
    vatPercent: example.vatPercent,
  };
}

/** Puts the minimum back above minus the room cost, and the target at or above the minimum. */
function ordered(values: Adjustable, moved: 'minRate' | 'targetRate' | 'roomCost'): Adjustable {
  const minRate = Math.max(values.minRate, -values.roomCost);
  if (moved === 'targetRate') {
    return { ...values, minRate: Math.min(minRate, values.targetRate) };
  }
  return { ...values, minRate, targetRate: Math.max(values.targetRate, minRate) };
}

function sameValues(a: Adjustable, b: Adjustable): boolean {
  return (
    a.students === b.students &&
    a.roomCost === b.roomCost &&
    a.minRate === b.minRate &&
    a.targetRate === b.targetRate &&
    a.vatPercent === b.vatPercent
  );
}

interface ControlProps {
  id: string;
  label: string;
  readout: ReactNode;
  hint: string;
}

function Control({ id, label, readout, hint, children }: ControlProps & { children: ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="type-label text-ink">
          {label}
        </label>
        {readout}
      </div>
      {children}
      <p className="type-caption">{hint}</p>
    </div>
  );
}

function PillButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`min-h-11 px-4 rounded-pill border type-label ${
        pressed ? 'bg-teal border-teal text-cream' : 'bg-transparent border-border text-ink hover:bg-sand-hover'
      }`}
    >
      {children}
    </button>
  );
}

export function PricingCalculator({ initialExample }: { initialExample: PricingExampleKey }) {
  const uid = useId();
  const [key, setKey] = useState(initialExample);
  const [values, setValues] = useState(() => adjustableOf(PRICING_EXAMPLES[initialExample]));
  const example = PRICING_EXAMPLES[key];
  const { minStudents, maxStudents } = example;
  const { students, roomCost, minRate, targetRate, vatPercent } = values;
  const goesAhead = students >= minStudents;

  function choose(next: PricingExampleKey) {
    setKey(next);
    setValues(adjustableOf(PRICING_EXAMPLES[next]));
    history.replaceState(null, '', `?example=${next}#examples`);
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="group" aria-label="Example classes" className="flex flex-wrap gap-2">
        {EXAMPLE_KEYS.map((k) => (
          <PillButton key={k} pressed={k === key} onClick={() => choose(k)}>
            {PRICING_EXAMPLES[k].label}
          </PillButton>
        ))}
      </div>
      <p className="type-body">{example.story}</p>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <div className="bg-sand border border-border rounded-card p-6 flex flex-col gap-6 [&_.type-caption]:text-brown">
          <Control
            id={`${uid}-students`}
            label="Students registered"
            hint={`The class runs from ${minStudents}; your target is reached at ${maxStudents}.`}
            readout={
              <span className="flex items-baseline gap-[5px] tabular-nums">
                <span className={`text-lg font-semibold ${goesAhead ? 'text-teal' : 'text-danger'}`}>{students}</span>
                <span className="text-sm text-brown">
                  / {minStudents}–{maxStudents}
                </span>
              </span>
            }
          >
            <RangeTrack
              id={`${uid}-students`}
              {...STUDENTS}
              step={1}
              value={students}
              tick={minStudents}
              fillClass={goesAhead ? 'bg-teal' : 'bg-danger'}
              aria-valuetext={`${students} students`}
              onChange={(e) => setValues({ ...values, students: Number(e.target.value) })}
            />
          </Control>

          <Control
            id={`${uid}-room`}
            label="Room cost"
            hint="What the room costs for the class"
            readout={<span className="type-number text-base">{formatMoney(roomCost, 'EUR')}</span>}
          >
            <RangeTrack
              id={`${uid}-room`}
              {...ROOM}
              value={roomCost}
              fillClass="bg-teal"
              aria-valuetext={formatMoney(roomCost, 'EUR')}
              onChange={(e) => setValues(ordered({ ...values, roomCost: Number(e.target.value) }, 'roomCost'))}
            />
          </Control>

          <Control
            id={`${uid}-minimum`}
            label="Your minimum"
            hint={
              minRate < 0
                ? 'Below zero: you cover part of the room yourself.'
                : `What you earn with ${minStudents} students`
            }
            readout={<span className="type-number text-base">{formatMoney(minRate, 'EUR')}</span>}
          >
            <RangeTrack
              id={`${uid}-minimum`}
              {...MINIMUM}
              value={minRate}
              fillClass="bg-teal"
              aria-valuetext={formatMoney(minRate, 'EUR')}
              onChange={(e) => setValues(ordered({ ...values, minRate: Number(e.target.value) }, 'minRate'))}
            />
          </Control>

          <Control
            id={`${uid}-target`}
            label="Your target"
            hint={
              targetRate === minRate
                ? 'Same as your minimum: a flat rate.'
                : `What you earn with ${maxStudents} or more`
            }
            readout={<span className="type-number text-base">{formatMoney(targetRate, 'EUR')}</span>}
          >
            <RangeTrack
              id={`${uid}-target`}
              {...TARGET}
              value={targetRate}
              fillClass="bg-teal"
              aria-valuetext={formatMoney(targetRate, 'EUR')}
              onChange={(e) => setValues(ordered({ ...values, targetRate: Number(e.target.value) }, 'targetRate'))}
            />
          </Control>

          <div role="group" aria-labelledby={`${uid}-vat`}>
            <p id={`${uid}-vat`} className="type-label text-ink mb-2">
              VAT
            </p>
            <div className="flex gap-2">
              {VAT_CHOICES.map((choice) => (
                <PillButton
                  key={choice.percent}
                  pressed={vatPercent === choice.percent}
                  onClick={() => setValues({ ...values, vatPercent: choice.percent })}
                >
                  {choice.label}
                </PillButton>
              ))}
            </div>
          </div>

          <button
            type="button"
            disabled={sameValues(values, adjustableOf(example))}
            onClick={() => setValues(adjustableOf(example))}
            className="self-start min-h-11 type-label text-teal underline disabled:text-brown-light disabled:no-underline disabled:cursor-default"
          >
            Reset to the example
          </button>
        </div>

        <div className="flex flex-col gap-6 lg:sticky lg:top-6">
          {/* Mounted empty so screen readers announce the note when it fills */}
          <p
            role="status"
            className={goesAhead ? '' : 'type-body text-danger border border-danger rounded-card p-5'}
          >
            {goesAhead
              ? null
              : `With ${students} students, this class is below your minimum of ${minStudents}. It would auto-cancel at the time you choose, and nobody pays.`}
          </p>
          {goesAhead && (
            <>
              <PricingPreviewResult
                currency="EUR"
                roomCost={roomCost}
                minRate={minRate}
                targetRate={targetRate}
                minStudents={minStudents}
                maxStudents={maxStudents}
                vatPercent={vatPercent}
                distribution={normalSpread(students)}
                showRateProgress={false}
              />
              {students > maxStudents && (
                <p className="type-caption">Above your target size, extra students only lower prices.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
