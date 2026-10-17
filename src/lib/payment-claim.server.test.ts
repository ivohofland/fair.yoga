import { describe, it, expect } from 'vitest';
import { claimDay } from './payment-claim.server';

describe('claimDay', () => {
  it('is the teacher’s calendar day, not the UTC one', () => {
    // 23:30 UTC on the 11th is already the 12th in Amsterdam.
    const at = new Date('2026-10-11T23:30:00Z');
    expect(claimDay(at, 'Europe/Amsterdam')).toEqual(new Date('2026-10-12T00:00:00Z'));
    expect(claimDay(at, 'UTC')).toEqual(new Date('2026-10-11T00:00:00Z'));
  });

  it('is null without a claim', () => {
    expect(claimDay(null, 'Europe/Amsterdam')).toBeNull();
  });
});
