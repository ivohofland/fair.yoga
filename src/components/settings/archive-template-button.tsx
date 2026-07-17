'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ArchiveTemplateButtonProps {
  templateId: string;
  isArchived: boolean;
}

export function ArchiveTemplateButton({ templateId, isArchived }: ArchiveTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/class-templates/${templateId}?action=archive`, {
        method: 'PATCH',
      });
      if (res.ok) {
        router.push('/settings/recurring');
      } else {
        setError('Failed to update. Please try again.');
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
          : (isArchived ? 'Unarchive recurring class' : 'Archive recurring class')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
