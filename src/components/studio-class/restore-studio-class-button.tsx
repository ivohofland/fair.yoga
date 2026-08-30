'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

interface RestoreStudioClassButtonProps {
  studioClassId: string;
}

export function RestoreStudioClassButton({ studioClassId }: RestoreStudioClassButtonProps) {
  const router = useRouter();
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');

  async function handleRestore() {
    setRestoring(true);
    setError('');
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelledAt: null }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not restore the class. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleRestore}
        disabled={restoring}
        className="type-label text-teal text-left disabled:opacity-50"
      >
        {restoring ? 'Restoring...' : 'Restore class'}
      </button>
      {error && <p className="type-caption text-danger mt-1">{error}</p>}
    </div>
  );
}
