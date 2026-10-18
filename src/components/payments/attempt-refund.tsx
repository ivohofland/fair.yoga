'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney } from '@/lib/format';
import { attemptRefundState, type AttemptRefundState, type AttemptView } from '@/lib/processor-attempt-view';
import { mollieMethodLabel } from '@/lib/processor-methods';
import { RefundDialog } from '@/components/payments/refund-dialog';

interface AttemptRefundProps {
  paymentId: string;
  attempt: AttemptView;
  /** Whether this attempt settled the payment, so its refund asks what becomes of the payment. */
  settles: boolean;
  studentName: string;
  /** The class, where the row names it; part of the button's accessible name. */
  classContext: string | null;
}

/**
 * One Mollie attempt's refund control on a teacher's payment row: Refund
 * while it can be refunded (after a failed refund too, saying so), and the
 * refund's state once one stands. Nothing for an attempt `attemptRefundState`
 * answers `none` for. A refund accepted here shows as pending, or refunded,
 * until the refreshed row says the same.
 */
export function AttemptRefund({ paymentId, attempt, settles, studentName, classContext }: AttemptRefundProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState<AttemptRefundState | null>(null);
  const state = requested ?? attemptRefundState(attempt);
  const paid = `${mollieMethodLabel(attempt.method)} ${formatMoney(attempt.amount, attempt.currency)}`;

  switch (state) {
    case 'none':
      return null;
    case 'pending':
      return <span className="type-caption">Refund pending</span>;
    case 'refunded':
      return <span className="type-caption">Refunded</span>;
    case 'refundable':
    case 'failed':
      return (
        <span className="inline-flex items-center gap-2">
          {state === 'failed' && <span className="type-caption text-danger">Refund failed</span>}
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={`Refund ${paid} — ${classContext === null ? studentName : `${studentName}, ${classContext}`}`}
            className="type-caption text-brown min-h-[44px] px-1"
          >
            Refund
          </button>
          {open && (
            <RefundDialog
              paymentId={paymentId}
              attemptId={attempt.id}
              amount={attempt.amount}
              currency={attempt.currency}
              studentName={studentName}
              settles={settles}
              onClose={() => setOpen(false)}
              onRequested={(status) => {
                setOpen(false);
                setRequested(status === 'refunded' ? 'refunded' : 'pending');
                router.refresh();
              }}
            />
          )}
        </span>
      );
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled refund state: ${String(unhandled)}`);
    }
  }
}

interface OtherAttemptsProps {
  paymentId: string;
  /** Attempts that did not settle the payment. */
  attempts: readonly AttemptView[];
  studentName: string;
  classContext: string | null;
}

/** A line per attempt that did not settle the payment and has a refund state to show: what it paid, and its `AttemptRefund`. */
export function OtherAttempts({ paymentId, attempts, studentName, classContext }: OtherAttemptsProps) {
  const shown = attempts.filter((a) => attemptRefundState(a) !== 'none');
  return shown.map((a) => (
    <div key={a.id} className="flex items-center gap-2">
      <span className="type-caption">
        {mollieMethodLabel(a.method)} {formatMoney(a.amount, a.currency)}
      </span>
      <AttemptRefund paymentId={paymentId} attempt={a} settles={false} studentName={studentName} classContext={classContext} />
    </div>
  ));
}
