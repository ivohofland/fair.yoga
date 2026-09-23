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
      'booking_removed',
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

  // The two cancellation types differ on exactly this, and nothing else
  // distinguishes them at the policy layer. A future edit that "tidies" the
  // pair into agreement has to delete this test to do it.
  it('splits the cancellation pair: a removal is essential, a self-cancel is not', () => {
    expect(isEssential('booking_removed')).toBe(true);
    expect(isEssential('booking_cancelled')).toBe(false);
  });
});

describe('isEmailEligible', () => {
  it('a waitlist promotion is eligible the moment it is created', () => {
    expect(
      isEmailEligible({ type: 'waitlist_promoted', createdAt: now, classStart: new Date('2026-06-02T12:00:00Z') }, now, 30),
    ).toBe(true);
  });

  it('another type a day before class still waits out the threshold', () => {
    expect(
      isEmailEligible({ type: 'booking_confirmed', createdAt: now, classStart: new Date('2026-06-02T12:00:00Z') }, now, 30),
    ).toBe(false);
  });

  it('is eligible once older than the threshold', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-45), classStart: null }, now, 30)).toBe(true);
  });

  it('is not eligible while fresh with no class', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-5), classStart: null }, now, 30)).toBe(false);
  });

  it('is eligible while fresh when the class starts within the urgent window', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-5), classStart: minutes(60) }, now, 30)).toBe(true);
  });

  it('is not eligible while fresh when the class is beyond the window', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-5), classStart: minutes(180) }, now, 30)).toBe(false);
  });

  it('includes a class starting exactly at the window boundary', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-5), classStart: minutes(120) }, now, 30)).toBe(true);
  });

  it('does not accelerate for a class starting right now', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-5), classStart: now }, now, 30)).toBe(false);
  });

  it('is not eligible at exactly the threshold age', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-30), classStart: null }, now, 30)).toBe(false);
  });

  it('does not accelerate for a class that already started', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-5), classStart: minutes(-10) }, now, 30)).toBe(false);
  });

  it('still respects age for a class that already started', () => {
    expect(isEmailEligible({ type: 'booking_confirmed', createdAt: minutes(-45), classStart: minutes(-10) }, now, 30)).toBe(true);
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

  it('mails a teacher-removed booking past the opt-out, but not a self-cancel', () => {
    expect(shouldEmailStudent('booking_removed', false)).toBe(true);
    expect(shouldEmailStudent('booking_cancelled', false)).toBe(false);
  });
});
