import { describe, it, expect } from 'vitest';
import { resolveSteps, isOnboardingComplete, isSettled } from './onboarding';

const nothingDone = {
  bio: '', payoutDetailsSet: false, roomCount: 0, classCount: 0, skipped: [],
};

describe('resolveSteps', () => {
  it('returns the four steps in order, none done', () => {
    const steps = resolveSteps(nothingDone);
    expect(steps.map((s) => s.key)).toEqual(['profile', 'bank', 'room', 'class']);
    expect(steps.every((s) => s.state === 'todo')).toBe(true);
  });

  it('marks profile done once a bio exists', () => {
    const [profile] = resolveSteps({ ...nothingDone, bio: 'Yoga since 2009.' });
    if (!profile) throw new Error('expected a profile step');
    expect(profile.state).toBe('done');
  });

  it('marks an optional step skipped', () => {
    const [profile] = resolveSteps({ ...nothingDone, skipped: ['profile'] });
    if (!profile) throw new Error('expected a profile step');
    expect(profile.state).toBe('skipped');
  });

  // Required steps carry no Skip control, and OnboardingStep has no member
  // for them — "skip a required step" is not expressible.
  it('reports which steps may be skipped', () => {
    const steps = resolveSteps(nothingDone);
    expect(steps.filter((s) => s.skipAs !== null).map((s) => s.key)).toEqual(['profile', 'bank']);
  });

  it('marks bank done once payout details are set', () => {
    const bank = resolveSteps({ ...nothingDone, payoutDetailsSet: true }).find((s) => s.key === 'bank');
    expect(bank?.state).toBe('done');
  });

  it('names the bank step for either way a student pays', () => {
    const bank = resolveSteps(nothingDone).find((s) => s.key === 'bank');
    expect({ label: bank?.label, detail: bank?.detail }).toEqual({
      label: 'Add how students pay you',
      detail: 'Bank details or a payment link — skip if you take cash',
    });
  });

  it('leaves bank to do without payout details', () => {
    expect(resolveSteps(nothingDone).find((s) => s.key === 'bank')?.state).toBe('todo');
  });

  it('holds back settling until the bank step is done or skipped', () => {
    const rest = { ...nothingDone, bio: 'x', roomCount: 1, classCount: 1 };
    expect(isSettled(rest)).toBe(false);
    expect(isSettled({ ...rest, payoutDetailsSet: true })).toBe(true);
    expect(isSettled({ ...rest, skipped: ['bank'] })).toBe(true);
  });
});

describe('isOnboardingComplete', () => {
  it('is false while a required step is outstanding', () => {
    expect(isOnboardingComplete({ ...nothingDone, bio: 'x', skipped: ['bank'] })).toBe(false);
  });

  it('is true when every step is done or skipped and share is dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', payoutDetailsSet: false, roomCount: 1, classCount: 1, skipped: ['bank', 'share'],
    })).toBe(true);
  });

  // The share card is the last thing seen; until it is dismissed the
  // checklist has not retired.
  it('is false when every step is settled but share is not dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', payoutDetailsSet: false, roomCount: 1, classCount: 1, skipped: ['bank'],
    })).toBe(false);
  });
});
