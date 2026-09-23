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
 */

import type { NotificationType } from '@prisma/client';

export const ESSENTIAL_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'class_cancelled',
  // Someone else ended the booking, so the student may otherwise turn up to a
  // class they believe they are in — the same reason `class_cancelled` is
  // here. Its sibling `booking_cancelled` is deliberately absent: that one is
  // the student's own cancellation coming back to them, and a receipt should
  // not be louder than the `booking_confirmed` it undoes, which is also
  // absent.
  'booking_removed',
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
 * make at that moment, and its free-cancel window is shorter than the threshold.
 */
export const IMMEDIATE_EMAIL_TYPES: ReadonlySet<NotificationType> = new Set(['waitlist_promoted']);

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
