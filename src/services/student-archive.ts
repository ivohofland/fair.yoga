/**
 * Archiving a student: the teacher's statement that nothing is live between
 * them. The invariant this module keeps, the "live" predicate it checks, and
 * every act that clears the flag again are stated once, in
 * `docs/data-model.md` (TeacherStudent).
 */

import type { Currency, Prisma, PrismaClient } from '@prisma/client';
import { OUTSTANDING_STATUSES } from '@/lib/payment-status';
import { setLockTimeout } from '@/lib/db-locks';
import { CHARGED_STATUSES } from './class-lifecycle';
import { lockTeacherStudentLink } from './roster-link';
import {
  outstandingChangedRefusal,
  outstandingRefusal,
  unbilledRefusal,
  type ArchiveRefusal,
  type OpenPayment,
} from './student-archive-copy';

export type { ArchiveRefusal } from './student-archive-copy';

/**
 * What `archiveStudent` did. `not-linked`: the pair has no link, so there is
 * nothing of this teacher's to file. `unchanged`: the link was already
 * archived, and nothing was written.
 */
export type ArchiveOutcome =
  | { kind: 'archived'; waivedCount: number }
  | { kind: 'unchanged' }
  | { kind: 'not-linked' }
  | { kind: 'refused'; refusal: ArchiveRefusal };

type Pair = { teacherId: string; studentId: string };

/**
 * Thrown inside the transaction when the waive wrote fewer rows than it read
 * open, so the whole transaction — waive and archive — rolls back. Caught in
 * `archiveStudent`, never outside this module.
 */
class OutstandingChangedError extends Error {}

/** This pair's open payments: outstanding, on this student's registrations, on this teacher's classes. */
async function readOpenPayments(db: Prisma.TransactionClient, { teacherId, studentId }: Pair): Promise<OpenPayment[]> {
  const rows = await db.payment.findMany({
    where: {
      status: { in: OUTSTANDING_STATUSES },
      registration: { studentId, class: { calendarEntry: { teacherId } } },
    },
    select: { id: true, amount: true, registration: { select: { class: { select: { currency: true } } } } },
  });
  return rows.map((r) => ({ id: r.id, amount: r.amount, currency: r.registration.class.currency }));
}

/** The teacher's current currency, which the refusal copy lists first. */
async function readTeacherCurrency(db: Prisma.TransactionClient, teacherId: string): Promise<Currency> {
  const teacher = await db.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { currency: true } });
  return teacher.currency;
}

/** True when `given`, de-duplicated, names exactly the ids in `open`. */
function sameIdSet(given: readonly string[], open: readonly string[]): boolean {
  const givenSet = new Set(given);
  const openSet = new Set(open);
  return givenSet.size === openSet.size && [...givenSet].every((id) => openSet.has(id));
}

/**
 * Archive the `(teacher, student)` link, refusing while anything is live.
 *
 * `waivePaymentIds` is the teacher's confirm: the open payments they were
 * shown. It is honoured only when it names exactly this pair's open set, so
 * it is a compare-and-swap on what the teacher saw and no id outside that set
 * reaches a write (`docs/data-model.md`, TeacherStudent).
 *
 * The link row is locked first; every act that makes something live takes
 * the same lock (`docs/lock-order.md`, "The `TeacherStudent` row is the
 * archive's gate"), so the counts below cannot miss a booking that commits
 * alongside this call.
 */
export async function archiveStudent(
  db: PrismaClient,
  input: { teacherId: string; studentId: string; waivePaymentIds?: readonly string[] },
): Promise<ArchiveOutcome> {
  const { teacherId, studentId, waivePaymentIds } = input;
  const pair: Pair = { teacherId, studentId };
  try {
    return await db.$transaction(async (tx): Promise<ArchiveOutcome> => {
      await setLockTimeout(tx);
      const link = await lockTeacherStudentLink(tx, pair);
      if (!link) return { kind: 'not-linked' };
      if (link.isArchived) return { kind: 'unchanged' };

      // Before payments: waiving cannot resolve a registration completion would still bill.
      const unbilled = await tx.registration.count({
        where: {
          studentId,
          status: { in: [...CHARGED_STATUSES] },
          class: { status: { not: 'completed' }, calendarEntry: { teacherId, cancelledAt: null } },
        },
      });
      if (unbilled > 0) return { kind: 'refused', refusal: unbilledRefusal(unbilled) };

      const open = await readOpenPayments(tx, pair);
      if (open.length > 0) {
        const openIds = open.map((p) => p.id);
        if (waivePaymentIds === undefined) {
          return { kind: 'refused', refusal: outstandingRefusal(open, await readTeacherCurrency(tx, teacherId)) };
        }
        if (!sameIdSet(waivePaymentIds, openIds)) {
          return { kind: 'refused', refusal: outstandingChangedRefusal(open, await readTeacherCurrency(tx, teacherId)) };
        }
        // Status-filtered: a payment read open above can be settled before
        // this write lands — which payment writers skip the link lock is
        // `docs/lock-order.md` ("The `TeacherStudent` row is the archive's
        // gate", What the archive does not lock).
        const { count } = await tx.payment.updateMany({
          where: { id: { in: openIds }, status: { in: OUTSTANDING_STATUSES } },
          data: { status: 'not_charged', notChargedAt: new Date() },
        });
        if (count !== open.length) throw new OutstandingChangedError();
      }

      await tx.teacherStudent.update({ where: { id: link.id }, data: { isArchived: true } });
      return { kind: 'archived', waivedCount: open.length };
    });
  } catch (err) {
    if (!(err instanceof OutstandingChangedError)) throw err;
    // Re-read under the link lock again: the rollback released it, so the
    // pair may have been unlinked since, and then there is nothing to archive.
    return db.$transaction(async (tx): Promise<ArchiveOutcome> => {
      await setLockTimeout(tx);
      if (!(await lockTeacherStudentLink(tx, pair))) return { kind: 'not-linked' };
      return { kind: 'refused', refusal: outstandingChangedRefusal(await readOpenPayments(tx, pair), await readTeacherCurrency(tx, teacherId)) };
    });
  }
}
