'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PaymentStatus } from '@prisma/client';
import { timeAgo } from '@/lib/format';
import { usePaymentActions } from '@/lib/use-payment-actions';
import { SendReminderButton } from '@/components/class/send-reminder-button';

interface OutstandingPaymentRowProps {
  paymentId: string;
  studentName: string;
  classId: string;
  /** "{classType} · {date}" — the row's visible sub-label *and* the reminder aria-label context. */
  classContext: string;
  amount: number;
  status: PaymentStatus;
  reminderSentAt: Date | null;
}

/**
 * One Outstanding row on the payments overview. A client component because the
 * reminder button and the mark-paid action must share paid-state: once a
 * payment is marked paid the reminder button has to disappear, or a teacher
 * could dun a student they just marked as having paid. Mark-paid deliberately
 * does not refresh (the row keeps its transient Undo); Undo does refresh, which
 * also re-seeds the reminded caption from the (force-dynamic) server read.
 */
export function OutstandingPaymentRow({
  paymentId,
  studentName,
  classId,
  classContext,
  amount,
  status,
  reminderSentAt,
}: OutstandingPaymentRowProps) {
  const router = useRouter();
  const { paymentState, justMarked, updating, error, markPaid, undo } = usePaymentActions({
    [paymentId]: status,
  });
  const [remindedAt, setRemindedAt] = useState<Date | null>(reminderSentAt);

  const current = paymentState[paymentId] ?? status;
  const isPaid = current === 'paid';
  const isOutstanding = current === 'pending' || current === 'overdue';
  const busy = updating === paymentId;

  return (
    <div className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <p className="text-base text-ink">{studentName}</p>
        <p className="type-caption">
          <Link href={`/class/${classId}`} className="no-underline text-brown-light">
            {classContext}
          </Link>
          {current === 'overdue' && <span className="text-danger"> · ! overdue</span>}
        </p>
        {remindedAt && <p className="type-caption">Reminded {timeAgo(remindedAt)}</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="type-number text-brown">€{amount.toFixed(2)}</span>
        {isOutstanding && (
          <SendReminderButton
            paymentId={paymentId}
            studentName={studentName}
            context={classContext}
            onSent={setRemindedAt}
          />
        )}
        {isPaid ? (
          <span className="inline-flex items-center gap-2">
            <span className="type-caption text-teal">✓ Paid</span>
            {justMarked.has(paymentId) && (
              <button
                type="button"
                onClick={async () => {
                  await undo(paymentId);
                  router.refresh();
                }}
                disabled={busy}
                className="type-caption text-teal min-h-[44px] px-1"
                aria-label={`Undo marking ${studentName} as paid`}
              >
                Undo
              </button>
            )}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => markPaid(paymentId)}
            disabled={busy}
            className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint ${busy ? 'opacity-50' : ''}`}
            aria-label={`Mark ${studentName} payment as paid`}
          >
            {busy ? 'Saving...' : 'Mark paid'}
          </button>
        )}
        {error && (
          <span role="alert" className="type-caption text-danger">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
