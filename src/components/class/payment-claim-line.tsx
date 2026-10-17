import { formatDateLong, formatDateShort } from '@/lib/format';

interface PaymentClaimLineProps {
  /** Whether the claimed payment is overdue; the line carries that state for its row. */
  overdue: boolean;
  /**
   * The day the student marked it sent, already in the teacher's zone
   * (`claimDay`): a calendar day at UTC midnight, not the raw instant.
   */
  reportedOn: Date;
}

/**
 * A teacher-side row's note that the student says they have paid, with the
 * day they said so. Render it only while the claim stands.
 *
 * Overdue is spelled out in the `sr-only` text as well as coloured, so the
 * state is not colour alone (WCAG 1.4.1); the visible text is hidden from
 * assistive tech so it is not read twice.
 */
export function PaymentClaimLine({ overdue, reportedOn }: PaymentClaimLineProps) {
  return (
    <p className={`type-caption ${overdue ? 'text-danger' : 'text-brown'}`}>
      <span className="sr-only">
        {overdue ? 'Overdue, says paid on ' : 'Says paid on '}
        {formatDateLong(reportedOn)}
      </span>
      <span aria-hidden="true">
        {overdue ? '! ' : ''}Says paid · {formatDateShort(reportedOn)}
      </span>
    </p>
  );
}
