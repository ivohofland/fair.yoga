'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface CompleteClassButtonProps {
  classId: string;
}

export function CompleteClassButton({ classId }: CompleteClassButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handleComplete() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/classes/${classId}/complete`, {
        method: 'POST',
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleComplete}
      disabled={submitting}
      className="border border-teal text-teal rounded-none px-4 py-2 text-sm font-medium min-h-[44px]"
    >
      {submitting ? 'Completing...' : 'Complete class'}
    </button>
  );
}
