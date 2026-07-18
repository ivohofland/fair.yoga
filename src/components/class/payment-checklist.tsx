'use client';

import { useState } from 'react';
import Link from 'next/link';
import { paymentStateText } from '@/lib/format';

export interface PaymentItem {
  paymentId: string;
  studentId: string;
  studentName: string;
  amount: number;
  status: string; // 'pending' | 'paid' | 'overdue'
}

interface PaymentChecklistProps {
  items: PaymentItem[];
}

export function PaymentChecklist({ items }: PaymentChecklistProps) {
  const [paymentState, setPaymentState] = useState<Record<string, string>>(
    Object.fromEntries(items.map((item) => [item.paymentId, item.status])),
  );
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function markPaid(paymentId: string) {
    setUpdating(paymentId);
    setError(null);
    try {
      const response = await fetch(`/api/payments/${paymentId}/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'manual' }),
      });

      if (response.ok) {
        setPaymentState((prev) => ({
          ...prev,
          [paymentId]: 'paid',
        }));
      } else if (response.status === 409) {
        const body = await response.json() as { error?: string };
        setError(body.error ?? 'This payment cannot be marked as paid in its current state.');
      } else {
        setError('Failed to mark payment as paid. Please try again.');
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setUpdating(null);
    }
  }

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

      {error && (
        <p role="alert" className="text-danger text-sm mb-3">
          {error}
        </p>
      )}

      <div>
        {items.map((item) => {
          const status = paymentState[item.paymentId] ?? 'pending';
          const isPaid = status === 'paid';
          const isUpdating = updating === item.paymentId;

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
                <span className={`type-caption ${paymentStateText(status).className}`}>
                  {paymentStateText(status).label}
                </span>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <span className={`type-number ${isPaid ? '' : 'text-brown'}`}>
                  &euro;{item.amount.toFixed(2)}
                </span>
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
