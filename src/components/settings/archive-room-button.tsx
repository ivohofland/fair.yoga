'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ArchiveRoomButtonProps {
  teacherRoomId: string;
  isArchived: boolean;
}

export function ArchiveRoomButton({ teacherRoomId, isArchived }: ArchiveRoomButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}`, { method: 'PATCH' });
      if (res.ok) {
        router.push('/settings/rooms');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={loading}
      className="text-brown text-sm opacity-60"
    >
      {loading
        ? (isArchived ? 'Unarchiving...' : 'Archiving...')
        : (isArchived ? 'Unarchive room' : 'Archive room')}
    </button>
  );
}
