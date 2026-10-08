/**
 * Payment Reminders — scheduled dunning for Level 1 payments.
 *
 * Policy:
 * - A pending payment becomes overdue OVERDUE_AFTER_DAYS after the later of
 *   its creation (at class completion) and the teacher's last resume of
 *   payments; never while the teacher has payments paused.
 * - Overdue payments get a reminder notification, repeated at most once
 *   every REMIND_EVERY_DAYS (deduped via Payment.reminderSentAt).
 * - Tone stays calm: unpaid is brown, never alarming — the reminder is a
 *   nudge, not a threat.
 */

import type { PrismaClient } from '@prisma/client';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { studentPaymentReminderBody } from '@/lib/payment-request-copy';
import { payGuidanceFor, paymentMethodsForTeacher, teacherPaymentSelect } from '@/lib/payment-methods';
import { readInPages } from '@/lib/read-in-pages';

export const OVERDUE_AFTER_DAYS = 7;
export const REMIND_EVERY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Flips to overdue each pending payment whose OVERDUE_AFTER_DAYS have run,
 * counted from the later of `createdAt` and the teacher's `paymentsResumedAt`.
 * A paused teacher's payments never flip: students are being asked to hold off paying.
 */
export async function markOverduePayments(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - OVERDUE_AFTER_DAYS * DAY_MS);
  const result = await db.payment.updateMany({
    where: {
      status: 'pending',
      createdAt: { lt: cutoff },
      registration: {
        class: {
          calendarEntry: {
            teacher: {
              paymentsPausedAt: null,
              OR: [{ paymentsResumedAt: null }, { paymentsResumedAt: { lt: cutoff } }],
            },
          },
        },
      },
    },
    data: { status: 'overdue' },
  });
  return result.count;
}

/** One page of `readDuePayments`, keyed on `id`. */
function readDuePaymentPage(
  db: PrismaClient,
  remindCutoff: Date,
  afterId: string | undefined,
  take: number,
) {
  return db.payment.findMany({
    where: {
      status: 'overdue',
      OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: remindCutoff } }],
      // Erased accounts end the dunning: a deleted student reads nothing,
      // and a deleted teacher has no bank account or payment link left to pay into.
      // A paused teacher's students are asked to hold off, so they are not chased.
      registration: {
        student: { deletedAt: null },
        class: { calendarEntry: { teacher: { deletedAt: null, paymentsPausedAt: null } } },
      },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    include: {
      registration: {
        select: {
          studentId: true,
          class: {
            select: {
              id: true,
              currency: true,
              calendarEntry: {
                select: {
                  classType: true,
                  date: true,
                  startTime: true,
                  teacher: { select: teacherPaymentSelect },
                },
              },
            },
          },
        },
      },
    },
  });
}

export type DuePayment = Awaited<ReturnType<typeof readDuePaymentPage>>[number];

/**
 * The overdue payments `sendPaymentReminders` reminds: not reminded since
 * `remindCutoff`, with neither side of the payment erased and the teacher's
 * payments not paused. Read
 * `SWEEP_PAGE_SIZE` at a time via `readInPages` (`@/lib/read-in-pages`); why
 * is in `docs/technical-architecture.md` ("Relation loads over platform-wide
 * sets").
 */
export function readDuePayments(db: PrismaClient, remindCutoff: Date): Promise<DuePayment[]> {
  return readInPages<DuePayment>((after, take) => readDuePaymentPage(db, remindCutoff, after?.id, take));
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

  const due = await readDuePayments(db, remindCutoff);

  if (due.length === 0) return 0;

  let reminded = 0;
  for (const payment of due) {
    const cls = payment.registration.class;
    const guidance = payGuidanceFor(paymentMethodsForTeacher(cls.calendarEntry.teacher, cls.currency));
    // Stamp + notify in ONE transaction. The conditional stamp keeps two
    // overlapping cron runs from double-sending; the transaction keeps a
    // failed notification from stamping a reminder that never went out
    // (which would silence dunning for that payment for a full cycle).
    const didRemind = await db.$transaction(async (tx) => {
      const stamped = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: 'overdue',
          OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: remindCutoff } }],
        },
        data: { reminderSentAt: now },
      });
      if (stamped.count === 0) return false;

      const notifications: CreateNotificationInput[] = [
        {
          recipientType: 'student',
          recipientId: payment.registration.studentId,
          type: 'reminder',
          title: 'Payment outstanding',
          body: studentPaymentReminderBody(cls.calendarEntry, Number(payment.amount), guidance, cls.currency),
          relatedClassId: cls.id,
        },
      ];
      await createBulkNotifications(tx, notifications);
      return true;
    });
    if (didRemind) reminded++;
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
