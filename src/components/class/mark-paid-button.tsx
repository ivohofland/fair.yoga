'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface MarkPaidButtonProps {
  paymentId: string;
}

// Compact pill action; the paid state itself is text, never a badge.
export function MarkPaidButton({ paymentId }: MarkPaidButtonProps) {
  const router = useRouter();
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState(false);

  async function markPaid() {
    setUpdating(true);
    setError(false);
    try {
      const res = await fetch(`/api/payments/${paymentId}/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'manual' }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={markPaid}
        disabled={updating}
        className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint ${updating ? 'opacity-50' : ''}`}
      >
        {updating ? 'Saving...' : 'Mark paid'}
      </button>
      {error && <span className="text-[13px] text-danger">Failed</span>}
    </span>
  );
}
