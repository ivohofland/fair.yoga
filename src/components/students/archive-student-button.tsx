'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ArchiveStudentButtonProps {
  studentId: string;
  isArchived: boolean;
}

export function ArchiveStudentButton({ studentId, isArchived }: ArchiveStudentButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleToggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/students/${studentId}`, { method: 'PATCH' });
      if (res.ok) {
        router.push('/students');
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
        : (isArchived ? 'Unarchive student' : 'Archive student')}
    </button>
  );
}
