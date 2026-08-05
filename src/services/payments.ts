/**
 * Payment Service — Manages payment lifecycle after creation.
 *
 * Payments are created by completeClass (in class-lifecycle.ts).
 * This service handles status transitions, reminders, and queries.
 */

import type { PrismaClient, Payment, RegistrationStatus } from '@prisma/client';
import { createBulkNotifications } from './notifications';
import {
  projectStudentForTeacher,
  studentVisibilitySelect,
  type TeacherVisibleStudent,
} from '@/lib/student-visibility';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PaymentResult = { ok: true; payment: Payment } | { ok: false; error: string };

/**
 * What a teacher-facing payment read returns.
 *
 * Both query functions below used to declare `Promise<Payment[]>` while
 * returning a structural superset carrying the student's name and email — it
 * type-checked, and the signature is exactly why nobody reading it could see
 * the disclosure. The `registration` shape is explicit for the same reason:
 * an un-`select`ed `include` shipped `tierAtBooking` and `tierRatio`, which are
 * stored copies of the student's income tier.
 */
export type TeacherPaymentRow = Payment & {
  registration: {
    id: string;
    status: RegistrationStatus;
    student: TeacherVisibleStudent;
    class: { classType: string; date: Date };
  };
};

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * Mark a payment as paid with the given method (e.g. 'bank_transfer', 'cash').
 * Sets status to 'paid', records the method, and timestamps paidAt.
 *
 * Only valid from 'pending' or 'overdue' status.
 */
export async function markPaymentPaid(
  db: PrismaClient,
  paymentId: string,
  method: string,
): Promise<PaymentResult> {
  // Conditional update: the status guard lives in the WHERE clause so a
  // double submission cannot both pass a pre-check and clobber method/paidAt.
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
    data: {
      status: 'paid',
      method,
      paidAt: new Date(),
    },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
    return {
      ok: false,
      error: `Cannot mark payment as paid: current status is "${payment.status}". Must be "pending" or "overdue".`,
    };
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { ok: true, payment: updated };
}

/**
 * Mark a payment as overdue.
 * Typically called by a scheduled job when a pending payment passes its due window.
 *
 * Only valid from 'pending' status.
 */
export async function markPaymentOverdue(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentResult> {
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };

  if (payment.status !== 'pending') {
    return {
      ok: false,
      error: `Cannot mark payment as overdue: current status is "${payment.status}". Must be "pending".`,
    };
  }

  const updated = await db.payment.update({
    where: { id: paymentId },
    data: {
      status: 'overdue',
    },
  });
  return { ok: true, payment: updated };
}

/**
 * Undo a mistaken "mark paid": paid → pending, clearing method/paidAt.
 * Returns to 'pending' (not 'overdue') deliberately — the daily dunning
 * sweep re-derives overdue from the payment's age, so an old payment
 * self-heals back to overdue within a day.
 */
export async function unmarkPaymentPaid(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentResult> {
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: 'paid' },
    data: { status: 'pending', method: null, paidAt: null },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
    return {
      ok: false,
      error: `Cannot undo: current status is "${payment.status}". Must be "paid".`,
    };
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { ok: true, payment: updated };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/**
 * Send a payment reminder: stamps reminderSentAt and creates the student's
 * reminder notification in one transaction.
 *
 * Only valid on an outstanding ('pending' or 'overdue') payment, and the guard
 * is fail-closed in the DB, not just the UI: dunning a student who has already
 * paid is the one failure this feature must never produce. The status check is
 * a conditional updateMany (compare-and-swap in the WHERE), the same idiom as
 * markPaymentPaid and the automatic sweep — so a concurrent mark-paid that
 * commits between a plain read and the write genuinely can't be raced past.
 * The notification and the stamp share the transaction, so a failed send rolls
 * the stamp back rather than silencing the next scheduled reminder.
 */
export async function sendPaymentReminder(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentResult> {
  return db.$transaction(async (tx): Promise<PaymentResult> => {
    // Compare-and-swap: the status guard lives in the WHERE clause, so a count
    // of 0 means the payment is no longer outstanding (paid, or gone) and
    // nothing is sent.
    const stamped = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
      data: { reminderSentAt: new Date() },
    });
    if (stamped.count === 0) {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
      return {
        ok: false,
        error: `Cannot send a reminder: current status is "${payment.status}". Must be "pending" or "overdue".`,
      };
    }

    const { registration, ...payment } = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        registration: {
          select: { studentId: true, class: { select: { id: true, classType: true } } },
        },
      },
    });

    await createBulkNotifications(tx, [
      {
        recipientType: 'student',
        recipientId: registration.studentId,
        type: 'reminder',
        title: 'Payment outstanding',
        body: `€${Number(payment.amount).toFixed(2)} for ${registration.class.classType} is still open. Pay your teacher directly.`,
        relatedClassId: registration.class.id,
      },
    ]);

    return { ok: true, payment };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all outstanding (pending or overdue) payments for a teacher.
 *
 * Follows the relation chain: Payment → Registration → Class → Teacher.
 * Includes registration with the teacher-visible student projection and
 * class type/date.
 */
export async function getOutstandingPayments(
  db: PrismaClient,
  teacherId: string,
): Promise<TeacherPaymentRow[]> {
  const rows = await db.payment.findMany({
    where: {
      status: { in: ['pending', 'overdue'] },
      registration: { class: { teacherId } },
    },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(teacherId) },
          class: { select: { classType: true, date: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    registration: {
      ...row.registration,
      student: projectStudentForTeacher(row.registration.student),
    },
  }));
}

/**
 * Get all payments for a specific class.
 *
 * Includes registration with the teacher-visible student projection.
 */
export async function getPaymentsForClass(
  db: PrismaClient,
  classId: string,
  teacherId: string,
): Promise<TeacherPaymentRow[]> {
  const rows = await db.payment.findMany({
    where: { registration: { classId } },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(teacherId) },
          class: { select: { classType: true, date: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    registration: {
      ...row.registration,
      student: projectStudentForTeacher(row.registration.student),
    },
  }));
}
