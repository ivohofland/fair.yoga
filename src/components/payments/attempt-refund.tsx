'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ProcessorRefundStatus } from '@/lib/prisma-client';
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

/** What the row shows for a refund this control just requested, from the status Mollie answered. */
function requestedState(status: ProcessorRefundStatus): AttemptRefundState | null {
  switch (status) {
    case 'queued':
    case 'pending':
    case 'processing':
      return 'pending';
    case 'refunded':
      return 'refunded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return null;
    default: {
      const unhandled: never = status;
      throw new Error(`unhandled refund status: ${String(unhandled)}`);
    }
  }
}

/**
 * One Mollie attempt's refund control on a teacher's payment row: Refund
 * while it can be refunded (after a failed refund too, saying so), and the
 * refund's state once one stands. Nothing for an attempt `attemptRefundState`
 * answers `none` for. A refund requested here shows the state Mollie's
 * answer gives it, with focus on that line, until the attempt's refunds from
 * the server change.
 */
export function AttemptRefund({ paymentId, attempt, settles, studentName, classContext }: AttemptRefundProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [requested, setRequested] = useState<AttemptRefundState | null>(null);
  const refundsSeen = attempt.refunds.map((r) => r.status).join(',');
  const [seen, setSeen] = useState(refundsSeen);
  if (seen !== refundsSeen) {
    setSeen(refundsSeen);
    setRequested(null);
  }
  const status = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (requested !== null) status.current?.focus();
  }, [requested]);

  const state = requested ?? attemptRefundState(attempt);
  const paid = `${mollieMethodLabel(attempt.method)} ${formatMoney(attempt.amount, attempt.currency)}`;

  switch (state) {
    case 'none':
      return null;
    case 'pending':
      return <span ref={status} tabIndex={-1} className="type-caption focus:outline-none">Refund pending</span>;
    case 'refunded':
      return <span ref={status} tabIndex={-1} className="type-caption focus:outline-none">Refunded</span>;
    case 'refundable':
    case 'failed':
      return (
        <span className="inline-flex items-center gap-2">
          {state === 'failed' && (
            <span ref={status} tabIndex={-1} className="type-caption text-danger focus:outline-none">
              Refund failed
            </span>
          )}
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
              onRequested={(answered) => {
                setOpen(false);
                setRequested(requestedState(answered));
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
