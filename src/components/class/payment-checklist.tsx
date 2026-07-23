'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PaymentStatus } from '@prisma/client';
import { paymentStateText, timeAgo } from '@/lib/format';
import { usePaymentActions } from '@/lib/use-payment-actions';
import { SendReminderButton } from '@/components/class/send-reminder-button';

export interface PaymentItem {
  paymentId: string;
  studentId: string;
  studentName: string;
  amount: number;
  status: PaymentStatus;
  reminderSentAt: Date | null;
}

interface PaymentChecklistProps {
  items: PaymentItem[];
}

export function PaymentChecklist({ items }: PaymentChecklistProps) {
  const { paymentState, justMarked, updating, error, markPaid, undo } = usePaymentActions(
    Object.fromEntries(items.map((item) => [item.paymentId, item.status])),
  );
  // Reminded stamps live here, not inside each button: the button unmounts
  // when a row is marked paid, so the "Reminded …" caption would otherwise
  // vanish on a paid → undo bounce and take the anti-nag guardrail with it.
  const [remindedAt, setRemindedAt] = useState<Record<string, Date | null>>(() =>
    Object.fromEntries(items.map((item) => [item.paymentId, item.reminderSentAt])),
  );
  // Reminder failures surface in the shared top region (below), never in the
  // action cluster where a long message would overflow the row on a phone.
  const [reminderError, setReminderError] = useState('');

  if (items.length === 0) {
    return (
      <div className="py-6">
        <h2 className="type-subtitle mb-3">Payments</h2>
        <p className="type-body">No payments to track.</p>
      </div>
    );
  }

  return (
    <div className="py-6">
      <h2 className="type-subtitle mb-3">Payments</h2>

      {(error || reminderError) && (
        <p role="alert" className="text-danger text-sm mb-3">
          {error || reminderError}
        </p>
      )}

      <div>
        {items.map((item) => {
          const status = paymentState[item.paymentId] ?? 'pending';
          const isPaid = status === 'paid';
          const isOutstanding = status === 'pending' || status === 'overdue';
          const isUpdating = updating === item.paymentId;
          const reminded = remindedAt[item.paymentId];
          const stateText = paymentStateText(status);

          return (
            <div
              key={item.paymentId}
              className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0"
            >
              <div className="flex flex-col min-w-0">
                <Link href={`/students/${item.studentId}`} className="text-base text-ink no-underline">
                  {item.studentName}
                </Link>
                {/* Payment state is text, never a badge — unpaid stays calm brown */}
                <span className={`type-caption ${stateText.className}`}>{stateText.label}</span>
                {reminded && <span className="type-caption">Reminded {timeAgo(reminded)}</span>}
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className={`type-number ${isPaid ? '' : 'text-brown'}`}>
                  &euro;{item.amount.toFixed(2)}
                </span>
                {isOutstanding && (
                  <SendReminderButton
                    paymentId={item.paymentId}
                    studentName={item.studentName}
                    context={null}
                    onSent={(date) =>
                      setRemindedAt((prev) => ({ ...prev, [item.paymentId]: date }))
                    }
                    onError={setReminderError}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (!isPaid) markPaid(item.paymentId);
                  }}
                  disabled={isPaid || isUpdating}
                  className={`
                    h-9 px-4 rounded-pill text-[13px] font-medium
                    ${isPaid
                      ? 'border-[1.5px] border-transparent bg-teal text-cream'
                      : 'border-[1.5px] border-teal text-teal hover:bg-teal-tint'}
                    ${isUpdating ? 'opacity-50' : ''}
                  `}
                  aria-label={
                    isPaid
                      ? `${item.studentName} payment is paid`
                      : `Mark ${item.studentName} payment as paid`
                  }
                >
                  {isPaid ? 'Paid' : 'Mark paid'}
                </button>
                {isPaid && justMarked.has(item.paymentId) && (
                  <button
                    type="button"
                    onClick={() => undo(item.paymentId)}
                    disabled={isUpdating}
                    className="type-caption text-teal min-h-[44px] px-1"
                    aria-label={`Undo marking ${item.studentName} as paid`}
                  >
                    Undo
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
