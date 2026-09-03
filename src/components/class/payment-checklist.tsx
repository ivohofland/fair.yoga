'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { PaymentStatus } from '@prisma/client';
import { paymentStateText, timeAgo } from '@/lib/format';
import { isOutstanding } from '@/lib/payment-status';
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
          // `?? item.status`, not `?? 'pending'`: `noUncheckedIndexedAccess`
          // makes this read `PaymentStatus | undefined`, and the row's own
          // server-rendered status is the honest answer for the undefined case.
          // Fabricating 'pending' would render an already-paid or overdue
          // payment as plain unpaid (#58 review).
          const status = paymentState[item.paymentId] ?? item.status;
          const isPaid = status === 'paid';
          const outstanding = isOutstanding(status);
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
                <span className={`type-number ${outstanding ? 'text-brown' : ''}`}>
                  &euro;{item.amount.toFixed(2)}
                </span>
                {outstanding && (
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
                {outstanding && (
                  <button
                    type="button"
                    onClick={() => markPaid(item.paymentId)}
                    disabled={isUpdating}
                    className={`
                      h-9 px-4 rounded-pill text-[13px] font-medium
                      border-[1.5px] border-teal text-teal hover:bg-teal-tint
                      ${isUpdating ? 'opacity-50' : ''}
                    `}
                    // Leads with the visible label for WCAG 2.5.3 (Label in Name)
                    // and speech-input matching.
                    aria-label={`Mark paid — ${item.studentName}`}
                  >
                    Mark paid
                  </button>
                )}
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
