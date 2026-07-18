'use client';

import { useRouter } from 'next/navigation';
import { usePaymentActions } from '@/lib/use-payment-actions';

interface MarkPaidButtonProps {
  paymentId: string;
}

// Compact pill action; the paid state itself is text, never a badge.
// No refresh right after marking: the row would leave the outstanding
// list and take the transient Undo with it.
export function MarkPaidButton({ paymentId }: MarkPaidButtonProps) {
  const router = useRouter();
  const { paymentState, justMarked, updating, error, markPaid, undo } = usePaymentActions({
    [paymentId]: 'pending',
  });
  const isPaid = paymentState[paymentId] === 'paid';
  const busy = updating === paymentId;

  if (isPaid) {
    return (
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
          >
            Undo
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={() => markPaid(paymentId)}
        disabled={busy}
        className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint ${busy ? 'opacity-50' : ''}`}
      >
        {busy ? 'Saving...' : 'Mark paid'}
      </button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </span>
  );
}
