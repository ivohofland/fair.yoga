/**
 * Delivery policy for the email fallback (layer 3).
 *
 * Two independent axes:
 * - WHETHER: essential types are service messages about the student's
 *   own booking — they bypass Student.emailNotifications. The
 *   per-teacher receiveComms mute is not consulted here; it already
 *   filters announcements at creation time.
 * - WHEN: class-linked notifications become email-eligible immediately
 *   when the class starts within the urgent window, instead of waiting
 *   out the unread threshold. Urgency never overrides consent.
 *
 * Teacher recipients decide WHETHER through `TEACHER_EMAIL_POLICY` below,
 * keyed by `TeacherNotificationType`; WHEN is shared.
 */

import type {
  NotificationType,
  ReminderChannel,
  ReminderTiming,
  TeacherBookingNotifications,
} from '@prisma/client';

export const ESSENTIAL_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'class_cancelled',
  // Someone else ended the booking, so the student may otherwise turn up to a
  // class they believe they are in — the same reason `class_cancelled` is
  // here. Its sibling `booking_cancelled` is deliberately absent: that one is
  // the student's own cancellation coming back to them, and a receipt should
  // not be louder than the `booking_confirmed` it undoes, which is also
  // absent.
  'booking_removed',
  // A booking someone else made for the student, which carries a price they
  // will owe.
  'walk_in_added',
  'waitlist_promoted',
  'spot_available',
  'spot_taken',
  'payment_request',
]);

export function isEssential(type: NotificationType): boolean {
  return ESSENTIAL_NOTIFICATION_TYPES.has(type);
}

export const URGENT_WINDOW_MINUTES = 120;

/**
 * Types emailed on the first fallback sweep after they are created, not after
 * the unread threshold. A waitlist promotion is a booking the student did not
 * make at that moment, so it should reach them without waiting on the
 * ordinary unread threshold below; a walk-in is a booking made for them at
 * the door, so the same reasoning applies.
 */
export const IMMEDIATE_EMAIL_TYPES: ReadonlySet<NotificationType> = new Set([
  'waitlist_promoted',
  'walk_in_added',
]);

export function isEmailEligible(
  input: { type: NotificationType; createdAt: Date; classStart: Date | null },
  now: Date,
  thresholdMinutes: number,
): boolean {
  if (IMMEDIATE_EMAIL_TYPES.has(input.type)) return true;

  const oldEnough =
    input.createdAt.getTime() < now.getTime() - thresholdMinutes * 60 * 1000;
  if (oldEnough) return true;

  if (input.classStart === null) return false;
  const untilStartMs = input.classStart.getTime() - now.getTime();
  return untilStartMs > 0 && untilStartMs <= URGENT_WINDOW_MINUTES * 60 * 1000;
}

export function shouldEmailStudent(
  type: NotificationType,
  emailNotifications: boolean,
): boolean {
  return isEssential(type) || emailNotifications;
}

/**
 * What a teacher recipient can be sent. Adding a member fails
 * `TEACHER_EMAIL_POLICY`'s `satisfies` until it is classified there.
 */
export type TeacherNotificationType =
  | 'booking_confirmed'
  | 'class_cancelled'
  | 'payment_request'
  | 'teacher_invitation'
  | 'class_reminder';

/**
 * The teacher's notification settings. `TEACHER_EMAIL_POLICY` reads only those
 * that govern a fallback email; the class-reminder settings govern none.
 */
export interface TeacherNotificationPrefs {
  bookingNotifications: TeacherBookingNotifications;
  emailOnClassCompleted: boolean;
  emailOnInvitation: boolean;
  classReminder: ReminderTiming;
  classReminderChannel: ReminderChannel;
}

/**
 * The teacher's own counterpart to `ESSENTIAL_NOTIFICATION_TYPES`, kept apart
 * because whether an email is essential depends on the recipient (see
 * `ESSENTIAL_NOTIFICATION_TYPES`). A teacher's `class_cancelled` ignores every
 * preference, because the system ended the class without the teacher acting.
 */
const TEACHER_EMAIL_POLICY = {
  class_cancelled: () => true,
  booking_confirmed: (p: TeacherNotificationPrefs) => p.bookingNotifications === 'inbox_and_email',
  payment_request: (p: TeacherNotificationPrefs) => p.emailOnClassCompleted,
  teacher_invitation: (p: TeacherNotificationPrefs) => p.emailOnInvitation,
  // Never by fallback, whatever the preferences; why is in `docs/data-model.md`
  // (Notification, `email_sent`).
  class_reminder: () => false,
} satisfies Record<TeacherNotificationType, (prefs: TeacherNotificationPrefs) => boolean>;

export function isTeacherNotificationType(type: NotificationType): type is TeacherNotificationType {
  return Object.hasOwn(TEACHER_EMAIL_POLICY, type);
}

export function shouldEmailTeacher(
  type: TeacherNotificationType,
  prefs: TeacherNotificationPrefs,
): boolean {
  return TEACHER_EMAIL_POLICY[type](prefs);
}
