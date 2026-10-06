import { describe, it, expect } from 'vitest';
import { resolveSteps, isOnboardingComplete, isSettled } from './onboarding';

const nothingDone = {
  bio: '', bankIban: null, bankAccountName: null, currency: 'EUR' as const, roomCount: 0, classCount: 0, skipped: [],
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

  it('marks bank done once the IBAN and its holder name exist', () => {
    const bank = resolveSteps({
      ...nothingDone,
      bankIban: 'NL91ABNA0417164300',
      bankAccountName: 'I. Hofland',
    }).find((s) => s.key === 'bank');
    expect(bank?.state).toBe('done');
  });

  // Students are shown bank details only when both exist, so the checklist
  // must not call the step done on the IBAN alone.
  it('leaves bank to do with an IBAN but no holder name', () => {
    const bank = resolveSteps({
      ...nothingDone,
      bankIban: 'NL91ABNA0417164300',
      bankAccountName: null,
    }).find((s) => s.key === 'bank');
    expect(bank?.state).toBe('todo');
  });
});

describe('the bank step', () => {
  const withBank = { ...nothingDone, bankIban: 'NL91ABNA0417164300', bankAccountName: 'A' };

  it('is done for a euro teacher with account details', () => {
    expect(resolveSteps(withBank).find((s) => s.key === 'bank')?.state).toBe('done');
  });

  // A currency with no bank method has no bank step to take: students are
  // never shown the details, so the step is not listed at all.
  it('is not listed for a teacher in another currency', () => {
    expect(resolveSteps({ ...withBank, currency: 'GBP' }).map((s) => s.key)).toEqual(['profile', 'room', 'class']);
    expect(resolveSteps({ ...nothingDone, currency: 'GBP' }).map((s) => s.key)).toEqual(['profile', 'room', 'class']);
  });

  it('does not hold back settling for a teacher in another currency', () => {
    expect(isSettled({ ...nothingDone, currency: 'GBP', bio: 'x', roomCount: 1, classCount: 1 })).toBe(true);
    expect(isSettled({ ...nothingDone, currency: 'EUR', bio: 'x', roomCount: 1, classCount: 1 })).toBe(false);
  });
});

describe('isOnboardingComplete', () => {
  it('is false while a required step is outstanding', () => {
    expect(isOnboardingComplete({ ...nothingDone, bio: 'x', skipped: ['bank'] })).toBe(false);
  });

  it('is true when every step is done or skipped and share is dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', bankIban: null, bankAccountName: null, currency: 'EUR' as const, roomCount: 1, classCount: 1, skipped: ['bank', 'share'],
    })).toBe(true);
  });

  // The share card is the last thing seen; until it is dismissed the
  // checklist has not retired.
  it('is false when every step is settled but share is not dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', bankIban: null, bankAccountName: null, currency: 'EUR' as const, roomCount: 1, classCount: 1, skipped: ['bank'],
    })).toBe(false);
  });
});
