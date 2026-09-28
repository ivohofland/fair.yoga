/**
 * The words an archive refusal is shown to the teacher in (`archiveStudent`,
 * `student-archive.ts`). Pure: every value it formats is handed in.
 */

import { Prisma } from '@prisma/client';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { formatEuro } from '@/lib/format';

/** Why an archive is refused. Each message is shown to the teacher verbatim. */
export type ArchiveRefusal = Extract<
  CodedRefusal,
  { code: 'STUDENT_HAS_UNBILLED_CLASSES' | 'STUDENT_HAS_OUTSTANDING_PAYMENTS' }
>;

/** An open payment, as far as the copy needs it. */
export type OpenPayment = { id: string; amount: Prisma.Decimal };

/** "€x across n payment(s)", summed as decimals so no cent is lost to float addition. */
export function owedPhrase(open: readonly OpenPayment[]): string {
  const total = open.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
  const n = open.length;
  return `${formatEuro(total.toNumber())} across ${n} ${n === 1 ? 'payment' : 'payments'}`;
}

export function unbilledRefusal(n: number): ArchiveRefusal {
  return codedRefusal(
    'STUDENT_HAS_UNBILLED_CLASSES',
    `This student is booked on ${n} ${n === 1 ? 'class' : 'classes'} that ${n === 1 ? "hasn't" : "haven't"} been billed yet. Remove them from ${n === 1 ? 'it' : 'those classes'}, or archive once ${n === 1 ? "it's" : "they're"} completed.`,
  );
}

/**
 * The first ask's answer, when a plain archive (no waive) meets money owed.
 * The archive button opens its waive confirm on the next tap, which is what
 * the last sentence tells the teacher to do.
 */
export function outstandingRefusal(open: readonly OpenPayment[]): ArchiveRefusal {
  const n = open.length;
  return codedRefusal(
    'STUDENT_HAS_OUTSTANDING_PAYMENTS',
    `This student still owes ${owedPhrase(open)}. Tap Archive student again to waive ${n === 1 ? 'it' : 'them'} and archive.`,
  );
}

/**
 * The answer to a waive whose ids no longer match what is owed. An empty set
 * is reachable only through `archiveStudent`'s re-read after a waive miss,
 * when every payment the waive named was settled meanwhile.
 */
export function outstandingChangedRefusal(open: readonly OpenPayment[]): ArchiveRefusal {
  return codedRefusal(
    'STUDENT_HAS_OUTSTANDING_PAYMENTS',
    open.length === 0
      ? 'What this student owes has changed — nothing is outstanding now. Try again.'
      : `What this student owes has changed — now ${owedPhrase(open)}. Check it and try again.`,
  );
}
