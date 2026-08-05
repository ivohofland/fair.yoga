'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

interface PublishClassButtonProps {
  classId: string;
}

export function PublishClassButton({ classId }: PublishClassButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handlePublish() {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/classes/${classId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        // Fourth of the family fixed on this branch (#166 re-review M5),
        // after `ArchiveStudentButton`, `ArchiveContactButton` and
        // `ArchiveRoomButton`. Success here is a repaint, so silence on
        // failure repaints nothing and the class stays a draft — visually
        // identical to a click that never registered.
        setError(await readErrorMessage(res, 'Could not publish. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handlePublish}
        disabled={submitting}
        className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
      >
        {submitting ? 'Publishing...' : 'Publish'}
      </button>
      {error && <p className="type-caption text-danger text-right">{error}</p>}
    </div>
  );
}
