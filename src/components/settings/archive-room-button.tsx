'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

interface ArchiveRoomButtonProps {
  teacherRoomId: string;
  isArchived: boolean;
}

export function ArchiveRoomButton({ teacherRoomId, isArchived }: ArchiveRoomButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `/api/teacher-rooms/${teacherRoomId}?state=${isArchived ? 'unarchived' : 'archived'}`,
        { method: 'PATCH' },
      );
      if (res.ok) {
        router.push('/settings/rooms');
      } else {
        // The third of three identical instances: `ArchiveStudentButton` and
        // `ArchiveContactButton` both ran `if (res.ok)` with no `else` and no
        // `catch` until #166 fixed them. Success here navigates away, so
        // silence on failure is indistinguishable from a click that never
        // registered — the button re-enables and the page is unchanged.
        // Wording matches this directory's other PATCH toggles
        // (`archive-template-button.tsx`, `archive-studio-template-button.tsx`),
        // which differ from the student/contact pair's direction-naming copy.
        setError(await readErrorMessage(res, 'Failed to update. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
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
          : (isArchived ? 'Unarchive room' : 'Archive room')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
