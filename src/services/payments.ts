/**
 * Payment Service — Manages payment lifecycle after creation.
 *
 * Payments are created by completeClass (in class-lifecycle.ts).
 * This service handles status transitions, reminders, and queries.
 */

import type { PrismaClient, Payment } from '@prisma/client';

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * Mark a payment as paid with the given method (e.g. 'bank_transfer', 'cash').
 * Sets status to 'paid', records the method, and timestamps paidAt.
 */
export async function markPaymentPaid(
  db: PrismaClient,
  paymentId: string,
  method: string,
): Promise<Payment> {
  return db.payment.update({
    where: { id: paymentId },
    data: {
      status: 'paid',
      method,
      paidAt: new Date(),
    },
  });
}

/**
 * Mark a payment as overdue.
 * Typically called by a scheduled job when a pending payment passes its due window.
 */
export async function markPaymentOverdue(
  db: PrismaClient,
  paymentId: string,
): Promise<Payment> {
  return db.payment.update({
    where: { id: paymentId },
    data: {
      status: 'overdue',
    },
  });
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/**
 * Record that a payment reminder was sent.
 * Sets reminderSentAt to the current timestamp.
 */
export async function sendPaymentReminder(
  db: PrismaClient,
  paymentId: string,
): Promise<Payment> {
  return db.payment.update({
    where: { id: paymentId },
    data: {
      reminderSentAt: new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all outstanding (pending or overdue) payments for a teacher.
 *
 * Follows the relation chain: Payment → Registration → Class → Teacher.
 * Includes registration with student name/email and class type/date.
 */
export async function getOutstandingPayments(
  db: PrismaClient,
  teacherId: string,
): Promise<Payment[]> {
  return db.payment.findMany({
    where: {
      status: { in: ['pending', 'overdue'] },
      registration: {
        class: {
          teacherId,
        },
      },
    },
    include: {
      registration: {
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          class: {
            select: {
              classType: true,
              date: true,
            },
          },
        },
      },
    },
  });
}

/**
 * Get all payments for a specific class.
 *
 * Includes registration with student name.
 */
export async function getPaymentsForClass(
  db: PrismaClient,
  classId: string,
): Promise<Payment[]> {
  return db.payment.findMany({
    where: {
      registration: {
        classId,
      },
    },
    include: {
      registration: {
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });
}
