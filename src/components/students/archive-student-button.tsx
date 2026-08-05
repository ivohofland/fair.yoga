'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

interface ArchiveStudentButtonProps {
  studentId: string;
  isArchived: boolean;
}

export function ArchiveStudentButton({ studentId, isArchived }: ArchiveStudentButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `/api/students/${studentId}?state=${isArchived ? 'unarchived' : 'archived'}`,
        { method: 'PATCH' },
      );
      if (res.ok) {
        router.push('/students');
      } else {
        // Success navigates away, so a failure that says nothing is
        // indistinguishable from a click that never registered — the button
        // re-enables and the page is unchanged. Same handling as
        // `toggle-template-button.tsx`, the other caption-styled PATCH toggle.
        setError(
          await readErrorMessage(
            res,
            `Could not ${isArchived ? 'unarchive' : 'archive'} this student. Try again.`,
          ),
        );
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleToggle}
        disabled={loading}
        className="type-caption"
      >
        {loading
          ? (isArchived ? 'Unarchiving...' : 'Archiving...')
          : (isArchived ? 'Unarchive student' : 'Archive student')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
