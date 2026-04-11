'use client';

import { useState } from 'react';

interface StudentPaymentItem {
  paymentId: string;
  classType: string;
  classDate: string;
  amount: number;
  status: string;
}

interface StudentPaymentListProps {
  items: StudentPaymentItem[];
}

export function StudentPaymentList({ items }: StudentPaymentListProps) {
  const [paymentState, setPaymentState] = useState<Record<string, string>>(
    Object.fromEntries(items.map((item) => [item.paymentId, item.status])),
  );
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function markPaid(paymentId: string) {
    setUpdating(paymentId);
    setError(null);
    try {
      const res = await fetch(`/api/payments/${paymentId}/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'manual' }),
      });

      if (res.ok) {
        setPaymentState((prev) => ({ ...prev, [paymentId]: 'paid' }));
      } else {
        setError('Failed to mark payment as paid.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setUpdating(null);
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-brown">No payment history.</p>;
  }

  return (
    <>
      {error && <p className="text-sm text-error mb-3">{error}</p>}
      <div className="flex flex-col">
        {items.map((item) => {
          const status = paymentState[item.paymentId] ?? 'pending';
          const isPaid = status === 'paid';
          const isUpdating = updating === item.paymentId;

          return (
            <div key={item.paymentId} className="flex justify-between items-center py-3 border-b border-border">
              <div>
                <p className="text-dark">{item.classType}</p>
                <p className="text-sm text-brown">{item.classDate}</p>
              </div>
              <div className="flex items-center gap-3">
                <p className="font-semibold text-teal">&euro;{item.amount.toFixed(2)}</p>
                {isPaid ? (
                  <span className="text-sm text-teal">paid</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => markPaid(item.paymentId)}
                    disabled={isUpdating}
                    className={`min-h-[44px] px-4 py-2 text-sm font-medium border-2 border-border text-brown rounded-lg ${isUpdating ? 'opacity-50' : 'active:bg-sand'}`}
                  >
                    Mark paid
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
