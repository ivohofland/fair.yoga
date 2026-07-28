'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { resolveStudioConfirmation, type TemplateToggleResponse } from './template-action-messages';

interface ArchiveStudioTemplateButtonProps {
  templateId: string;
  isArchived: boolean;
}

export function ArchiveStudioTemplateButton({ templateId, isArchived }: ArchiveStudioTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const target = isArchived ? 'unarchived' : 'archived';
      const res = await fetch(`/api/studio-class-templates/${templateId}?state=${target}`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: TemplateToggleResponse };
        setMessage(resolveStudioConfirmation(data) ?? '');
        router.refresh();
      } else {
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
          : (isArchived ? 'Unarchive studio class' : 'Archive studio class')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
      {message && <p className="type-caption mt-2">{message}</p>}
    </div>
  );
}
