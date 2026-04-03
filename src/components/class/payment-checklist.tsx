'use client';

import { useState } from 'react';

export interface PaymentItem {
  paymentId: string;
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

  async function markPaid(paymentId: string) {
    setUpdating(paymentId);
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
      }
    } finally {
      setUpdating(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="py-6">
        <h2 className="font-heading text-lg font-bold text-dark mb-3">
          Payments
        </h2>
        <p className="text-brown text-sm">No payments to track.</p>
      </div>
    );
  }

  return (
    <div className="py-6">
      <h2 className="font-heading text-lg font-bold text-dark mb-3">
        Payments
      </h2>

      <div>
        {items.map((item) => {
          const status = paymentState[item.paymentId] ?? 'pending';
          const isPaid = status === 'paid';
          const isUpdating = updating === item.paymentId;

          return (
            <div
              key={item.paymentId}
              className="flex items-center justify-between py-3 border-b border-border"
            >
              <div className="flex flex-col">
                <span className="text-dark text-sm">{item.studentName}</span>
                <span className="text-teal text-sm font-semibold">
                  &euro;{item.amount.toFixed(2)}
                </span>
              </div>

              <button
                type="button"
                onClick={() => {
                  if (!isPaid) markPaid(item.paymentId);
                }}
                disabled={isPaid || isUpdating}
                className={`
                  min-w-[44px] min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium
                  ${isPaid
                    ? 'bg-teal text-cream'
                    : 'border-2 border-border text-brown'}
                  ${isUpdating ? 'opacity-50' : ''}
                  ${!isPaid && !isUpdating ? 'active:bg-sand' : ''}
                `}
                aria-label={`Mark ${item.studentName} payment as ${isPaid ? 'paid' : 'unpaid'}`}
              >
                {isPaid ? 'Paid' : 'Mark paid'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
