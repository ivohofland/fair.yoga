import { describe, it, expect } from 'vitest';
import {
  ESSENTIAL_NOTIFICATION_TYPES,
  isEssential,
  isEmailEligible,
  shouldEmailStudent,
} from './notification-policy';

const now = new Date('2026-07-21T12:00:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60 * 1000);

describe('essential types', () => {
  it('covers exactly the booking-critical types', () => {
    expect([...ESSENTIAL_NOTIFICATION_TYPES].sort()).toEqual([
      'class_cancelled',
      'payment_request',
      'spot_available',
      'waitlist_promoted',
    ]);
  });

  it('classifies announcements and reminders as optional', () => {
    expect(isEssential('announcement')).toBe(false);
    expect(isEssential('reminder')).toBe(false);
    expect(isEssential('class_cancelled')).toBe(true);
  });
});

describe('isEmailEligible', () => {
  it('is eligible once older than the threshold', () => {
    expect(isEmailEligible({ createdAt: minutes(-45), classStart: null }, now, 30)).toBe(true);
  });

  it('is not eligible while fresh with no class', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: null }, now, 30)).toBe(false);
  });

  it('is eligible while fresh when the class starts within the urgent window', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: minutes(60) }, now, 30)).toBe(true);
  });

  it('is not eligible while fresh when the class is beyond the window', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: minutes(180) }, now, 30)).toBe(false);
  });

  it('does not accelerate for a class that already started', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: minutes(-10) }, now, 30)).toBe(false);
  });

  it('still respects age for a class that already started', () => {
    expect(isEmailEligible({ createdAt: minutes(-45), classStart: minutes(-10) }, now, 30)).toBe(true);
  });
});

describe('shouldEmailStudent', () => {
  it('essential types email even when the student opted out', () => {
    expect(shouldEmailStudent('class_cancelled', false)).toBe(true);
  });

  it('optional types honor the opt-out', () => {
    expect(shouldEmailStudent('announcement', false)).toBe(false);
    expect(shouldEmailStudent('announcement', true)).toBe(true);
  });
});
