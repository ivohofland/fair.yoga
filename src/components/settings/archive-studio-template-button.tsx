'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ArchiveStudioTemplateButtonProps {
  templateId: string;
  isArchived: boolean;
}

export function ArchiveStudioTemplateButton({ templateId, isArchived }: ArchiveStudioTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/studio-class-templates/${templateId}?action=archive`, {
        method: 'PATCH',
      });
      if (res.ok) {
        router.push('/settings/studio-classes');
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
        className="text-brown text-sm opacity-60"
      >
        {loading
          ? (isArchived ? 'Unarchiving...' : 'Archiving...')
          : (isArchived ? 'Unarchive studio class' : 'Archive studio class')}
      </button>
      {error && <p className="text-sm text-error mt-2">{error}</p>}
    </div>
  );
}
