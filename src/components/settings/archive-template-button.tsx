'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { resolveTemplateConfirmation, type TemplateToggleResponse } from './template-action-messages';

interface ArchiveTemplateButtonProps {
  templateId: string;
  isArchived: boolean;
}

export function ArchiveTemplateButton({ templateId, isArchived }: ArchiveTemplateButtonProps) {
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
      const res = await fetch(`/api/class-templates/${templateId}?state=${target}`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: TemplateToggleResponse };
        setMessage(resolveTemplateConfirmation(data) ?? '');
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
          : (isArchived ? 'Unarchive recurring class' : 'Archive recurring class')}
      </button>
      {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
      {message && <p className="type-caption mt-2">{message}</p>}
    </div>
  );
}
