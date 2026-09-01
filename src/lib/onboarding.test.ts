import { describe, it, expect } from 'vitest';
import { resolveSteps, isOnboardingComplete } from './onboarding';

const nothingDone = {
  bio: '', bankIban: null, roomCount: 0, classCount: 0, skipped: [],
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
});

describe('isOnboardingComplete', () => {
  it('is false while a required step is outstanding', () => {
    expect(isOnboardingComplete({ ...nothingDone, bio: 'x', skipped: ['bank'] })).toBe(false);
  });

  it('is true when every step is done or skipped and share is dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', bankIban: null, roomCount: 1, classCount: 1, skipped: ['bank', 'share'],
    })).toBe(true);
  });

  // The share card is the last thing seen; until it is dismissed the
  // checklist has not retired.
  it('is false when every step is settled but share is not dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', bankIban: null, roomCount: 1, classCount: 1, skipped: ['bank'],
    })).toBe(false);
  });
});
