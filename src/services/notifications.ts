/**
 * Notification Dispatcher — Creates notification records, manages read state,
 * and schedules email fallback.
 *
 * Notifications are the first layer of the three-layer communication system:
 * 1. In-app notification (real-time via SSE)
 * 2. In-app inbox (persistent record — this service)
 * 3. Email fallback (unread past a threshold — sooner when the linked class starts soon)
 */

import type {
  PrismaClient,
  Prisma,
  RecipientType,
  NotificationType,
  Notification,
} from '@prisma/client';
import { notificationBus } from '@/lib/event-bus';
import { log } from '@/lib/log';
import { isEmailEligible } from './notification-policy';
import { classStartInstant } from '@/lib/timezone';

/** Accepts a plain client or a transaction client so notification creation
 *  can participate in the caller's transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

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
/**
 * Publishes to the in-process SSE bus. Fire-and-forget: events are only
 * refresh hints for connected clients (server state stays the truth), so
 * an emit for a transaction that later rolls back is harmless, and a bus
 * failure must never break the write.
 */
function emitToBus(input: CreateNotificationInput, id: string): void {
  try {
    notificationBus.emitNotification({
      recipientId: input.recipientId,
      recipientType: input.recipientType,
      notification: {
        id,
        type: input.type,
        title: input.title,
        body: input.body,
        relatedClassId: input.relatedClassId,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    // never let live-update plumbing break notification creation — but a
    // dead bus means silent SSE, so it must at least reach the log.
    log.error({ err }, 'notification event-bus emit failed');
  }
}

export async function createNotification(
  db: Db,
  input: CreateNotificationInput,
): Promise<Notification> {
  const notification = await db.notification.create({
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
  emitToBus(input, notification.id);
  return notification;
}

/**
 * Creates multiple notifications in a single batch operation.
 *
 * Uses Prisma's createMany for efficiency. Returns the count of created records.
 */
export async function createBulkNotifications(
  db: Db,
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

  // createMany returns no rows; the bus event is a refresh hint, so a
  // synthetic id is fine — clients refetch, they don't render the payload.
  for (const input of inputs) {
    emitToBus(input, 'bulk');
  }

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
 * Returns unread, unsent notifications that are either older than the
 * threshold, or linked to a class starting within URGENT_WINDOW_MINUTES
 * (see notification-policy.ts — urgency changes when, never whether).
 *
 * Ordered by createdAt ASC (oldest first).
 *
 * @param thresholdMinutes — minutes a notification must remain unread before
 *   email fallback kicks in, unless the linked class starts within the
 *   urgent window. Defaults to 30.
 */
export async function getUnreadForEmailFallback(
  db: PrismaClient,
  thresholdMinutes = 30,
): Promise<Notification[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() - thresholdMinutes * 60 * 1000);

  // Class-linked rows are fetched regardless of age: a class starting
  // within the urgent window makes them eligible before the threshold.
  const candidates = await db.notification.findMany({
    where: {
      isRead: false,
      emailSent: false,
      OR: [{ createdAt: { lt: threshold } }, { relatedClassId: { not: null } }],
    },
    include: {
      relatedClass: {
        select: {
          date: true,
          startTime: true,
          teacher: { select: { defaultTimezone: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return candidates.filter((n) =>
    isEmailEligible(
      {
        createdAt: n.createdAt,
        classStart: n.relatedClass
          ? classStartInstant(
              n.relatedClass.date,
              n.relatedClass.startTime,
              n.relatedClass.teacher.defaultTimezone,
            )
          : null,
      },
      now,
      thresholdMinutes,
    ),
  );
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
