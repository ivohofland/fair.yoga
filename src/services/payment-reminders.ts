/**
 * Payment Reminders — scheduled dunning for Level 1 payments.
 *
 * Policy:
 * - A pending payment becomes overdue OVERDUE_AFTER_DAYS after it was
 *   created (payments are created at class completion).
 * - Overdue payments get a reminder notification, repeated at most once
 *   every REMIND_EVERY_DAYS (deduped via Payment.reminderSentAt).
 * - Tone stays calm: unpaid is brown, never alarming — the reminder is a
 *   nudge, not a threat.
 */

import type { PrismaClient } from '@prisma/client';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';

export const OVERDUE_AFTER_DAYS = 7;
export const REMIND_EVERY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Flips pending payments older than OVERDUE_AFTER_DAYS to overdue. */
export async function markOverduePayments(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - OVERDUE_AFTER_DAYS * DAY_MS);
  const result = await db.payment.updateMany({
    where: { status: 'pending', createdAt: { lt: cutoff } },
    data: { status: 'overdue' },
  });
  return result.count;
}

/**
 * Sends a reminder notification for each overdue payment that has not been
 * reminded in the last REMIND_EVERY_DAYS. Returns the number of reminders.
 */
export async function sendPaymentReminders(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const remindCutoff = new Date(now.getTime() - REMIND_EVERY_DAYS * DAY_MS);

  const due = await db.payment.findMany({
    where: {
      status: 'overdue',
      OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: remindCutoff } }],
    },
    include: {
      registration: {
        select: {
          studentId: true,
          class: { select: { id: true, classType: true } },
        },
      },
    },
  });

  if (due.length === 0) return 0;

  let reminded = 0;
  for (const payment of due) {
    // Stamp first, conditionally — two overlapping cron runs must not
    // both send a reminder for the same payment.
    const stamped = await db.payment.updateMany({
      where: {
        id: payment.id,
        status: 'overdue',
        OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: remindCutoff } }],
      },
      data: { reminderSentAt: now },
    });
    if (stamped.count === 0) continue;

    const notifications: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: payment.registration.studentId,
        type: 'reminder',
        title: 'Payment outstanding',
        body: `€${Number(payment.amount).toFixed(2)} for ${payment.registration.class.classType} is still open. Pay your teacher directly.`,
        relatedClassId: payment.registration.class.id,
      },
    ];
    await createBulkNotifications(db, notifications);
    reminded++;
  }

  return reminded;
}

/** The cron entry point: mark overdue, then remind. */
export async function processPaymentReminders(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ markedOverdue: number; reminded: number }> {
  const markedOverdue = await markOverduePayments(db, now);
  const reminded = await sendPaymentReminders(db, now);
  return { markedOverdue, reminded };
}
