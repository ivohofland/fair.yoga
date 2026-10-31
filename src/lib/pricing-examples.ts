import { normalSpread, previewClass } from '@/lib/pricing-preview';

export type PricingExampleKey = 'typical' | 'new-class' | 'popular' | 'flat-rate' | 'vat';

export interface PricingExample {
  label: string;
  story: string;
  students: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** 0 charges no VAT. */
  vatPercent: number;
}

export const PRICING_EXAMPLES = {
  typical: {
    label: 'A typical class',
    story: 'Seven students on a normal week. The room is covered and you earn well above your minimum.',
    students: 7,
    roomCost: 30,
    minRate: 40,
    targetRate: 90,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 0,
  },
  'new-class': {
    label: 'A new class',
    story:
      'Just starting out? A low minimum and a small minimum class size keep the class running while word gets around, instead of auto-cancelling.',
    students: 3,
    roomCost: 30,
    minRate: 10,
    targetRate: 70,
    minStudents: 2,
    maxStudents: 12,
    vatPercent: 0,
  },
  popular: {
    label: 'A popular class',
    story:
      'Full, plus two walk-ins. Your rate stays capped at your target, so every extra student lowers everyone’s price.',
    students: 14,
    roomCost: 30,
    minRate: 40,
    targetRate: 90,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 0,
  },
  'flat-rate': {
    label: 'A flat rate',
    story:
      'Prefer one simple income? Set your minimum and target to the same amount: you earn the same every class.',
    students: 8,
    roomCost: 30,
    minRate: 60,
    targetRate: 60,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 0,
  },
  vat: {
    label: 'With VAT',
    story:
      'Registered for VAT? Enter rates without it. Each student’s price includes their share, and what you earn stays the same.',
    students: 7,
    roomCost: 30,
    minRate: 40,
    targetRate: 90,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 21,
  },
} as const satisfies Record<PricingExampleKey, PricingExample>;

export const DEFAULT_EXAMPLE_KEY: PricingExampleKey = 'typical';

function isExampleKey(raw: string): raw is PricingExampleKey {
  return Object.hasOwn(PRICING_EXAMPLES, raw);
}

/** The example a `?example=` value names; the first of a repeated one, `typical` when unknown. */
export function parseExampleKey(raw: string | string[] | undefined): PricingExampleKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && isExampleKey(value) ? value : DEFAULT_EXAMPLE_KEY;
}

/** What the example's class earns and costs, in its normal spread of students. */
export function examplePreview(key: PricingExampleKey): ReturnType<typeof previewClass> {
  const { students, ...inputs } = PRICING_EXAMPLES[key];
  return previewClass(
    {
      roomCost: inputs.roomCost,
      minRate: inputs.minRate,
      targetRate: inputs.targetRate,
      minStudents: inputs.minStudents,
      maxStudents: inputs.maxStudents,
      vatPercent: inputs.vatPercent,
    },
    normalSpread(students),
  );
}
