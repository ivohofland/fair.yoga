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
  'waitlist_promoted',
  'spot_available',
  'payment_request',
]);

export function isEssential(type: NotificationType): boolean {
  return ESSENTIAL_NOTIFICATION_TYPES.has(type);
}

export const URGENT_WINDOW_MINUTES = 120;

export function isEmailEligible(
  input: { createdAt: Date; classStart: Date | null },
  now: Date,
  thresholdMinutes: number,
): boolean {
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
