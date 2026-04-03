/**
 * Notification Dispatcher — Creates notification records, manages read state,
 * and schedules email fallback.
 *
 * Notifications are the first layer of the three-layer communication system:
 * 1. In-app notification (real-time via SSE)
 * 2. In-app inbox (persistent record — this service)
 * 3. Email fallback (for unread notifications after a threshold)
 */

import type {
  PrismaClient,
  RecipientType,
  NotificationType,
  Notification,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateNotificationInput {
  recipientType: RecipientType; // 'teacher' | 'student'
  recipientId: string;
  type: NotificationType; // booking_confirmed, class_cancelled, etc.
  title: string;
  body: string;
  relatedClassId?: string;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Creates a single notification record.
 *
 * Defaults: isRead=false, emailSent=false.
 */
export async function createNotification(
  db: PrismaClient,
  input: CreateNotificationInput,
): Promise<Notification> {
  return db.notification.create({
    data: {
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      relatedClassId: input.relatedClassId ?? null,
      isRead: false,
      emailSent: false,
    },
  });
}

/**
 * Creates multiple notifications in a single batch operation.
 *
 * Uses Prisma's createMany for efficiency. Returns the count of created records.
 */
export async function createBulkNotifications(
  db: PrismaClient,
  inputs: CreateNotificationInput[],
): Promise<number> {
  const result = await db.notification.createMany({
    data: inputs.map((input) => ({
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      type: input.type,
      title: input.title,
      body: input.body,
      relatedClassId: input.relatedClassId ?? null,
      isRead: false,
      emailSent: false,
    })),
  });

  return result.count;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * Marks a notification as read.
 */
export async function markAsRead(
  db: PrismaClient,
  notificationId: string,
): Promise<void> {
  await db.notification.update({
    where: { id: notificationId },
    data: { isRead: true },
  });
}

// ---------------------------------------------------------------------------
// Email fallback
// ---------------------------------------------------------------------------

/**
 * Finds unread notifications eligible for email fallback.
 *
 * Returns notifications where:
 * - isRead = false
 * - emailSent = false
 * - createdAt < (now - thresholdMinutes)
 *
 * Ordered by createdAt ASC (oldest first).
 *
 * @param thresholdMinutes — minutes a notification must remain unread before
 *   email fallback kicks in. Defaults to 30.
 */
export async function getUnreadForEmailFallback(
  db: PrismaClient,
  thresholdMinutes = 30,
): Promise<Notification[]> {
  const threshold = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  return db.notification.findMany({
    where: {
      isRead: false,
      emailSent: false,
      createdAt: { lt: threshold },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Marks notifications as having had their email fallback sent.
 *
 * Called after the email dispatch job successfully sends emails for these
 * notification IDs.
 */
export async function markEmailSent(
  db: PrismaClient,
  notificationIds: string[],
): Promise<void> {
  await db.notification.updateMany({
    where: { id: { in: notificationIds } },
    data: { emailSent: true },
  });
}
