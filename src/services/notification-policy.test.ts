import { describe, it, expect } from 'vitest';
import {
  ESSENTIAL_NOTIFICATION_TYPES,
  isEssential,
  isEmailEligible,
  shouldEmailStudent,
  shouldEmailTeacher,
  isTeacherNotificationType,
  type TeacherNotificationPrefs,
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
      'spot_taken',
      'waitlist_promoted',
      'walk_in_added',
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

describe('walk-in', () => {
  it('treats a walk-in as essential and emails it on the first sweep', () => {
    expect(isEssential('walk_in_added')).toBe(true);
    expect(
      isEmailEligible(
        { type: 'walk_in_added', createdAt: new Date(), classStart: null },
        new Date(),
        30,
      ),
    ).toBe(true);
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

const ALL_ON: TeacherNotificationPrefs = {
  bookingNotifications: 'inbox_and_email',
  emailOnClassCompleted: true,
  emailOnInvitation: true,
  classReminder: 'morning_of',
  classReminderChannel: 'inbox_and_email',
};
const ALL_OFF: TeacherNotificationPrefs = {
  bookingNotifications: 'off',
  emailOnClassCompleted: false,
  emailOnInvitation: false,
  classReminder: 'off',
  classReminderChannel: 'inbox',
};

describe('shouldEmailTeacher', () => {
  it('always emails an auto-cancel, whatever the preferences', () => {
    expect(shouldEmailTeacher('class_cancelled', ALL_OFF)).toBe(true);
    expect(shouldEmailTeacher('class_cancelled', ALL_ON)).toBe(true);
  });

  // Each case flips ONLY the column it names, with every other column at the
  // value that would make the answer `true`. A function reading the wrong
  // column therefore answers true where false is expected.
  it.each([
    ['inbox_and_email', true],
    ['inbox_only', false],
    ['off', false],
  ] as const)('booking_confirmed with bookingNotifications=%s emails: %s', (value, expected) => {
    expect(shouldEmailTeacher('booking_confirmed', { ...ALL_ON, bookingNotifications: value })).toBe(expected);
  });

  it('payment_request follows emailOnClassCompleted only', () => {
    expect(shouldEmailTeacher('payment_request', { ...ALL_ON, emailOnClassCompleted: false })).toBe(false);
    expect(shouldEmailTeacher('payment_request', { ...ALL_OFF, emailOnClassCompleted: true })).toBe(true);
  });

  it('never emails a class reminder through the fallback, whatever the preferences (#721)', () => {
    expect(shouldEmailTeacher('class_reminder', ALL_ON)).toBe(false);
    expect(shouldEmailTeacher('class_reminder', ALL_OFF)).toBe(false);
  });

  it('teacher_invitation follows emailOnInvitation only', () => {
    expect(shouldEmailTeacher('teacher_invitation', { ...ALL_ON, emailOnInvitation: false })).toBe(false);
    expect(shouldEmailTeacher('teacher_invitation', { ...ALL_OFF, emailOnInvitation: true })).toBe(true);
  });
});

describe('isTeacherNotificationType', () => {
  it('accepts every type a teacher can receive', () => {
    for (const t of ['booking_confirmed', 'class_cancelled', 'payment_request', 'teacher_invitation', 'class_reminder'] as const) {
      expect(isTeacherNotificationType(t)).toBe(true);
    }
  });

  it('rejects student-only types', () => {
    expect(isTeacherNotificationType('announcement')).toBe(false);
    expect(isTeacherNotificationType('walk_in_added')).toBe(false);
  });
});
