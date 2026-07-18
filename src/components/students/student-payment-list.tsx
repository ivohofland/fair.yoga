'use client';

import { paymentStateText } from '@/lib/format';
import { usePaymentActions } from '@/lib/use-payment-actions';

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
  const { paymentState, justMarked, updating, error, markPaid, undo } = usePaymentActions(
    Object.fromEntries(items.map((item) => [item.paymentId, item.status])),
  );

  if (items.length === 0) {
    return <p className="type-body">No payment history.</p>;
  }

  return (
    <>
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
      <div className="flex flex-col">
        {items.map((item) => {
          const status = paymentState[item.paymentId] ?? 'pending';
          const isPaid = status === 'paid';
          const isUpdating = updating === item.paymentId;

          return (
            <div key={item.paymentId} className="flex justify-between items-center gap-3 min-h-14 py-2 border-b border-border last:border-b-0">
              <div className="min-w-0">
                <p className="text-base text-ink">{item.classType}</p>
                {/* Payment state is text, never a badge */}
                <p className={`type-caption ${paymentStateText(status).className}`}>
                  {item.classDate} &middot; {paymentStateText(status).label}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <p className={`type-number ${isPaid ? '' : 'text-brown'}`}>&euro;{item.amount.toFixed(2)}</p>
                {!isPaid && (
                  <button
                    type="button"
                    onClick={() => markPaid(item.paymentId)}
                    disabled={isUpdating}
                    className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint ${isUpdating ? 'opacity-50' : ''}`}
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
                  >
                    Undo
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
