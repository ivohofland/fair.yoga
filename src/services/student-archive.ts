/**
 * Archiving a student: the teacher's statement that nothing is live between
 * them. The invariant this module keeps, the "live" predicate it checks, and
 * every act that clears the flag again are stated once, in
 * `docs/data-model.md` (TeacherStudent).
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { OUTSTANDING_STATUSES } from '@/lib/payment-status';
import { formatEuro } from '@/lib/format';
import { CHARGED_STATUSES } from './class-lifecycle';
import { lockTeacherStudentLink } from './roster-link';

/** Why an archive is refused. Each message is shown to the teacher verbatim. */
export type ArchiveRefusal = Extract<
  CodedRefusal,
  { code: 'STUDENT_HAS_UNBILLED_CLASSES' | 'STUDENT_HAS_OUTSTANDING_PAYMENTS' }
>;

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
type OpenPayment = { id: string; amount: Prisma.Decimal };

/**
 * Thrown inside the transaction when the waive wrote fewer rows than it read
 * open, so the whole transaction — waive and archive — rolls back. Caught in
 * `archiveStudent`, never outside this module.
 */
class OutstandingChangedError extends Error {}

/** This pair's open payments: outstanding, on this student's registrations, on this teacher's classes. */
function readOpenPayments(db: Prisma.TransactionClient, { teacherId, studentId }: Pair): Promise<OpenPayment[]> {
  return db.payment.findMany({
    where: {
      status: { in: OUTSTANDING_STATUSES },
      registration: { studentId, class: { calendarEntry: { teacherId } } },
    },
    select: { id: true, amount: true },
  });
}

/** True when `given`, de-duplicated, names exactly the ids in `open`. */
function sameIdSet(given: readonly string[], open: readonly string[]): boolean {
  const givenSet = new Set(given);
  const openSet = new Set(open);
  return givenSet.size === openSet.size && [...givenSet].every((id) => openSet.has(id));
}

/** "€x across n payment(s)", summed as decimals so no cent is lost to float addition. */
function owedPhrase(open: readonly OpenPayment[]): string {
  const total = open.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const n = open.length;
  return `${formatEuro(total.toNumber())} across ${n} ${n === 1 ? 'payment' : 'payments'}`;
}

function unbilledRefusal(n: number): ArchiveRefusal {
  return codedRefusal(
    'STUDENT_HAS_UNBILLED_CLASSES',
    `This student is booked on ${n} ${n === 1 ? 'class' : 'classes'} that ${n === 1 ? "hasn't" : "haven't"} been billed yet. Remove them from ${n === 1 ? 'it' : 'those classes'}, or archive once ${n === 1 ? "it's" : "they're"} completed.`,
  );
}

function outstandingRefusal(open: readonly OpenPayment[]): ArchiveRefusal {
  const n = open.length;
  return codedRefusal(
    'STUDENT_HAS_OUTSTANDING_PAYMENTS',
    `This student still owes ${owedPhrase(open)}. Waive ${n === 1 ? 'it' : 'them'} to archive.`,
  );
}

/**
 * The answer to a waive whose ids no longer match what is owed. An empty set
 * is reachable only through `OutstandingChangedError`'s re-read, when every
 * payment the waive named was settled meanwhile.
 */
function outstandingChangedRefusal(open: readonly OpenPayment[]): ArchiveRefusal {
  return codedRefusal(
    'STUDENT_HAS_OUTSTANDING_PAYMENTS',
    open.length === 0
      ? 'What this student owes has changed — nothing is outstanding now. Try again.'
      : `What this student owes has changed — now ${owedPhrase(open)}. Check it and try again.`,
  );
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
          return { kind: 'refused', refusal: outstandingRefusal(open) };
        }
        if (!sameIdSet(waivePaymentIds, openIds)) {
          return { kind: 'refused', refusal: outstandingChangedRefusal(open) };
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
    return { kind: 'refused', refusal: outstandingChangedRefusal(await readOpenPayments(db, pair)) };
  }
}
