import { describe, it, expect } from 'vitest';
import { STUDENT_BOOKINGS_PATH, STUDENT_INVITATION_PATH, TEACHER_INVITATION_PATH, TEACHER_MOLLIE_PATH, payPagePath, studentNotificationHref, teacherNotificationHref } from './notification-links';

/**
 * #166 whole-branch review I5. A `teacher_invitation` notification carries no
 * `relatedClassId` — it is about a person, not a class — and both student
 * surfaces yielded null for anything without one. So the one notification
 * type whose entire purpose is to ask for a decision was the only one a
 * student could not click through to make it.
 */
describe('studentNotificationHref', () => {
  const openClass = {
    id: 'class-1',
    status: 'open' as const,
    format: 'in_person' as const,
    calendarEntry: { cancelledAt: null, teacher: { pageSlug: 'anna' } },
  };

  it('sends a teacher invitation to the page that can answer it', () => {
    expect(
      studentNotificationHref({ type: 'teacher_invitation', relatedClass: null }),
    ).toBe(STUDENT_INVITATION_PATH);
  });

  // The booking page has no Claim button and offers "Join the waitlist" to
  // someone already on it; `/bookings` is where these are acted on, and where
  // their emails already point.
  it.each(['spot_available', 'spot_taken', 'waitlist_promoted'] as const)(
    'sends %s to the student\'s bookings, as its email does',
    (type) => {
      expect(studentNotificationHref({ type, relatedClass: openClass })).toBe(STUDENT_BOOKINGS_PATH);
    },
  );

  it('sends a booking notification to the public page of its class', () => {
    expect(
      studentNotificationHref({ type: 'booking_confirmed', relatedClass: openClass }),
    ).toBe('/anna/book/class-1');
  });

  // The class routes the default target would use are teacher-only, and a
  // class that is no longer open has nothing a student can do on it either.
  it('yields null for a class that is no longer open', () => {
    expect(
      studentNotificationHref({
        type: 'class_cancelled',
        relatedClass: { ...openClass, status: 'completed' },
      }),
    ).toBeNull();
  });

  // #327 split the two halves of "no longer open" across two rows: a
  // cancelled class keeps its `open` status and carries `cancelledAt` on its
  // entry. Without this case the link would survive the split silently —
  // `status === 'open'` still passes, and the student is sent to a booking
  // page that `notFound()`s.
  it('yields null for a class cancelled on its entry, status untouched', () => {
    expect(
      studentNotificationHref({
        type: 'class_cancelled',
        relatedClass: {
          ...openClass,
          calendarEntry: { ...openClass.calendarEntry, cancelledAt: new Date() },
        },
      }),
    ).toBeNull();
  });

  it('yields null for anything else with no related class', () => {
    expect(studentNotificationHref({ type: 'announcement', relatedClass: null })).toBeNull();
  });

  const completedClass = { ...openClass, status: 'completed' as const };

  it('sends a payment request to the pay page of its class', () => {
    expect(
      studentNotificationHref({ type: 'payment_request', relatedClass: completedClass }),
    ).toBe('/bookings/class-1/pay');
  });

  it('sends a payment reminder to the pay page of its class', () => {
    expect(
      studentNotificationHref({ type: 'reminder', relatedClass: completedClass }),
    ).toBe('/bookings/class-1/pay');
  });

  it('yields null for a payment notification with no related class', () => {
    expect(studentNotificationHref({ type: 'payment_request', relatedClass: null })).toBeNull();
  });

  // #911: the link is a button on the student's booking, and the public
  // booking page never carries it.
  it.each(['booking_confirmed', 'walk_in_added', 'class_reminder'] as const)(
    'sends %s about an online class to the student\'s bookings, where its link is',
    (type) => {
      const onlineClass = { ...openClass, format: 'online' as const };
      expect(studentNotificationHref({ type, relatedClass: onlineClass })).toBe(STUDENT_BOOKINGS_PATH);
      expect(studentNotificationHref({ type, relatedClass: { ...onlineClass, status: 'in_progress' } }))
        .toBe(STUDENT_BOOKINGS_PATH);
    },
  );

  it('still sends a booking notification about an in-person class to its public page', () => {
    expect(studentNotificationHref({ type: 'class_reminder', relatedClass: openClass })).toBe('/anna/book/class-1');
  });

  it('keeps a type that carries no link on its usual target for an online class', () => {
    expect(
      studentNotificationHref({ type: 'announcement', relatedClass: { ...openClass, format: 'online' } }),
    ).toBe('/anna/book/class-1');
  });

  it('builds the pay page path from the class id', () => {
    expect(payPagePath('abc')).toBe('/bookings/abc/pay');
  });
});

describe('teacherNotificationHref (#172)', () => {
  it('sends a teacher invitation to the invitations page', () => {
    expect(teacherNotificationHref({ type: 'teacher_invitation', relatedClassId: null }))
      .toBe(TEACHER_INVITATION_PATH);
  });

  it('sends a class notification to its class', () => {
    expect(teacherNotificationHref({ type: 'booking_confirmed', relatedClassId: 'class-1' }))
      .toBe('/class/class-1');
  });

  it('sends a lost Mollie connection to the settings where it is reconnected', () => {
    expect(teacherNotificationHref({ type: 'processor_disconnected', relatedClassId: null })).toBe(TEACHER_MOLLIE_PATH);
    expect(TEACHER_MOLLIE_PATH).toBe('/settings/profile');
  });

  it('yields null for a notification with neither', () => {
    expect(teacherNotificationHref({ type: 'announcement', relatedClassId: null })).toBeNull();
  });
});
