import { describe, it, expect } from 'vitest';
import { STUDENT_INVITATION_PATH, studentNotificationHref } from './notification-links';

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
    calendarEntry: { cancelledAt: null, teacher: { pageSlug: 'anna' } },
  };

  it('sends a teacher invitation to the page that can answer it', () => {
    expect(
      studentNotificationHref({ type: 'teacher_invitation', relatedClass: null }),
    ).toBe(STUDENT_INVITATION_PATH);
  });

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
});
