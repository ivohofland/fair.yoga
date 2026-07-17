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
      className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
    >
      {submitting ? 'Completing...' : 'Complete class'}
    </button>
  );
}
