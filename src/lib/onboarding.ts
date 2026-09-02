import type { OnboardingStep } from '@prisma/client';

/** Steps that gate retirement but carry no Skip control. */
export type RequiredStepKey = 'room' | 'class';
/** Every row rendered in the checklist. `share` is the completion card, not a row. */
export type StepKey = Extract<OnboardingStep, 'profile' | 'bank'> | RequiredStepKey;

export type StepState = 'done' | 'skipped' | 'todo';

export interface StepInput {
  bio: string;
  bankIban: string | null;
  roomCount: number;
  classCount: number;
  skipped: OnboardingStep[];
}

export interface ResolvedStep {
  key: StepKey;
  label: string;
  detail: string;
  href: string;
  state: StepState;
  /** The `OnboardingStep` this row may be skipped as, or `null` if it's required. */
  skipAs: OnboardingStep | null;
}

const ORDER: readonly StepKey[] = ['profile', 'bank', 'room', 'class'];

function isDone(key: StepKey, input: StepInput): boolean {
  switch (key) {
    case 'profile': return input.bio !== '';
    case 'bank': return input.bankIban !== null;
    case 'room': return input.roomCount > 0;
    case 'class': return input.classCount > 0;
    default: {
      // Adding a StepKey without a done-condition fails to compile here.
      const never: never = key;
      return never;
    }
  }
}

const COPY: Record<StepKey, { label: string; detail: string; href: string }> = {
  profile: {
    label: 'Complete your profile',
    detail: 'A sentence or two so students know who they’re booking',
    href: '/settings/profile',
  },
  bank: {
    label: 'Add your bank details',
    detail: 'Students see them when it’s time to pay — skip if you take cash',
    href: '/settings/profile',
  },
  room: {
    label: 'Add a room',
    detail: 'Where you teach, and what it costs you',
    href: '/settings/rooms/new',
  },
  class: {
    label: 'Create your first class',
    detail: 'Set your rates once — pricing does the rest',
    href: '/class/new',
  },
};

function skippableKey(key: StepKey): OnboardingStep | null {
  return key === 'profile' || key === 'bank' ? key : null;
}

export function resolveSteps(input: StepInput): ResolvedStep[] {
  return ORDER.map((key) => {
    const skipAs = skippableKey(key);
    const state: StepState = isDone(key, input)
      ? 'done'
      : skipAs && input.skipped.includes(skipAs)
        ? 'skipped'
        : 'todo';
    return { key, ...COPY[key], state, skipAs };
  });
}

/** Every row done or skipped — required steps have no `skipAs`, so this
 *  genuinely requires `room`/`class` to exist, not merely be dismissed. */
export function isSettled(input: StepInput): boolean {
  return resolveSteps(input).every((s) => s.state !== 'todo');
}

/** Retired: every step settled, and the share card dismissed. */
export function isOnboardingComplete(input: StepInput): boolean {
  return isSettled(input) && input.skipped.includes('share');
}
