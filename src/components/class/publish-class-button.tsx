'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface PublishClassButtonProps {
  classId: string;
}

export function PublishClassButton({ classId }: PublishClassButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  async function handlePublish() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/classes/${classId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
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
      onClick={handlePublish}
      disabled={submitting}
      className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
    >
      {submitting ? 'Publishing...' : 'Publish'}
    </button>
  );
}
