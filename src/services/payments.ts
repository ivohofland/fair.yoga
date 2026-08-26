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
 * returning a structural superset — it type-checked, and the signature is
 * exactly why nobody reading it could see the disclosure. What each carried
 * differed: `getOutstandingPayments` selected the student's `firstName`,
 * `lastName` and `email`; `getPaymentsForClass` selected only `firstName`/
 * `lastName`, never `email`. But both used an un-`select`ed `include` on
 * `registration`, so both also shipped `tierAtBooking` and `tierRatio` —
 * stored copies of the student's income tier — regardless of what the
 * student `select` named.
 *
 * The `registration` shape below is explicit so a reader can see what is
 * returned — but do not mistake it for the guard. It is not one. Both query
 * functions build their rows with `...row.registration`, and TypeScript does
 * not excess-property-check spread properties against a declared return type:
 * adding `tierAtBooking: true` to either `select` (or spreading
 * `payment.registration` in `api/payments/[id]/route.ts` instead of building
 * it out field by field) re-ships the income tier with `tsc --noEmit` clean.
 * Verified, not assumed.
 *
 * What actually catches a widened `select` is
 * `tests/integration/payments-api.test.ts` — `:150` for
 * `getOutstandingPayments`, `:175` for `GET /api/payments/[id]`, `:211` for
 * `getPaymentsForClass` — each asserting `tierAtBooking`/`tierRatio`/`price`
 * are `undefined` on the wire. Widen a `select` here and the corresponding
 * assertion goes red; skip that suite and nothing else will tell you.
 *
 * Those assertions name the fields they deny, so they catch a widened `select`
 * and nothing else. The `Object.keys(…).sort()` assertion beside each of them
 * is the complement: it denies every key not on the allowlist, which is what
 * catches a `{ ...row.registration.student, ...projectStudentForTeacher(…) }`
 * spread re-attaching the raw surname. That one was missing from this family
 * until #167's round-two review — the spread left payments-api 22/22 and this
 * service's own unit file 14/14 green.
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
 * Returns to 'pending' (not 'overdue') deliberately — the dunning sweep
 * (`markOverduePayments`) re-derives overdue from the payment's age, so an old
 * payment self-heals back to overdue on the sweep's next tick. `lib/scheduler.ts`
 * registers that job (`payment-reminders`) at `60 * MINUTE`, so the window is an
 * hour, not the day this comment claimed.
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
 * How long a manual reminder suppresses an identical second one.
 *
 * Two minutes: long enough to absorb a double-click and a retried request from
 * a flaky connection, short enough that it is not an anti-nagging policy. That
 * distinction is deliberate — `send-reminder-button.tsx` documents the calm
 * "Reminded …" caption as the product's pressure against nagging, and a longer
 * window here would quietly replace a product stance with a mechanism. The
 * automatic sweep's own dedupe is a different quantity
 * (`REMIND_EVERY_DAYS`, `services/payment-reminders.ts`) and this cooldown
 * does not change its value — but they are not independent: both read and
 * write the same `reminderSentAt` column, so a manual send still defers the
 * sweep by a week, exactly as it did before this constant existed.
 */
export const MANUAL_REMIND_COOLDOWN_MS = 2 * 60 * 1000;

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
 *
 * The status is not the whole CAS, though, and on its own it could not stop a
 * double-click: a reminder does not change status, so two concurrent clicks
 * both read 'pending', both passed, both stamped and both dunned the student.
 * `reminderSentAt` is the value that actually moves, so it is in the WHERE too
 * — bounded by MANUAL_REMIND_COOLDOWN_MS, which is a retry guard and not a
 * nagging policy (#196).
 */
export async function sendPaymentReminder(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentResult> {
  return db.$transaction(async (tx): Promise<PaymentResult> => {
    // Compare-and-swap on both things a reminder depends on: the payment is
    // still outstanding, and it was not just reminded. A count of 0 means one
    // of those two stopped holding and nothing is sent.
    const cooldownStart = new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS);
    const stamped = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: { in: ['pending', 'overdue'] },
        OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: cooldownStart } }],
      },
      data: { reminderSentAt: new Date() },
    });
    if (stamped.count === 0) {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
      // Status before cooldown, and not the other way round: a settled payment
      // is settled whether or not it was reminded a minute ago, and telling
      // that teacher to try again shortly would promise a retry the status
      // guard refuses forever. Once the payment IS outstanding, the cooldown is
      // the only remaining term in the WHERE, so it is the only explanation
      // left.
      if (payment.status !== 'pending' && payment.status !== 'overdue') {
        return {
          ok: false,
          error: `Cannot send a reminder: current status is "${payment.status}". Must be "pending" or "overdue".`,
        };
      }
      return {
        ok: false,
        error: 'A reminder for this payment was just sent. Try again in a couple of minutes.',
      };
    }

    const { registration, ...payment } = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        registration: {
          select: {
            studentId: true,
            class: { select: { id: true, calendarEntry: { select: { classType: true } } } },
          },
        },
      },
    });

    await createBulkNotifications(tx, [
      {
        recipientType: 'student',
        recipientId: registration.studentId,
        type: 'reminder',
        title: 'Payment outstanding',
        body: `€${Number(payment.amount).toFixed(2)} for ${registration.class.calendarEntry.classType} is still open. Pay your teacher directly.`,
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
      registration: { class: { calendarEntry: { teacherId } } },
    },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(teacherId) },
          // Reshaped onto `TeacherPaymentRow`'s flat `{ classType, date }`
          // below: both moved to the entry in #327, and the projection is
          // this service's own type rather than a Prisma payload, so its
          // consumers are unaffected.
          class: { select: { calendarEntry: { select: { classType: true, date: true } } } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    registration: {
      ...row.registration,
      student: projectStudentForTeacher(row.registration.student, teacherId),
      class: {
        classType: row.registration.class.calendarEntry.classType,
        date: row.registration.class.calendarEntry.date,
      },
    },
  }));
}

/**
 * Get all payments for a specific class.
 *
 * `teacherId` does two jobs: it scopes the `where` to that teacher's own
 * class — so a caller who skips the route's own ownership check still can't
 * pull another teacher's payments — and it selects which teacher's
 * `StudentPrivacy` row the projection reads. Without the `where` scope, a
 * missing route guard wouldn't just leak the payments; it would render them
 * under the *caller's* privacy flags, which is more misleading than a raw
 * leak, not safer.
 *
 * Includes registration with the teacher-visible student projection and the
 * class's type/date — the previous version selected no `class` fields at
 * all.
 */
export async function getPaymentsForClass(
  db: PrismaClient,
  classId: string,
  teacherId: string,
): Promise<TeacherPaymentRow[]> {
  const rows = await db.payment.findMany({
    where: { registration: { classId, class: { calendarEntry: { teacherId } } } },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(teacherId) },
          // Reshaped onto `TeacherPaymentRow`'s flat `{ classType, date }`
          // below: both moved to the entry in #327, and the projection is
          // this service's own type rather than a Prisma payload, so its
          // consumers are unaffected.
          class: { select: { calendarEntry: { select: { classType: true, date: true } } } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    registration: {
      ...row.registration,
      student: projectStudentForTeacher(row.registration.student, teacherId),
      class: {
        classType: row.registration.class.calendarEntry.classType,
        date: row.registration.class.calendarEntry.date,
      },
    },
  }));
}
