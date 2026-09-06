'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import {
  resolveTemplateConfirmation,
  UNREADABLE_CONFIRMATION_MESSAGE,
  type TemplateToggleResponse,
} from './template-action-messages';

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
      let res: Response;
      try {
        res = await fetch(`/api/class-templates/${templateId}?state=${target}`, {
          method: 'PATCH',
        });
      } catch (err) {
        console.error('[archive-template] request failed', { templateId, err });
        setError('Network error. Please try again.');
        return;
      }

      if (res.ok) {
        let rawJson: unknown;
        try {
          rawJson = await res.json();
        } catch (err) {
          console.error('[archive-template] updated, but response body was unreadable', {
            templateId,
            err,
          });
          // #193: past res.ok the mutation committed. See UNREADABLE_CONFIRMATION_MESSAGE.
          setMessage(UNREADABLE_CONFIRMATION_MESSAGE);
        }

        if (rawJson !== undefined) {
          const { data } = rawJson as { data: TemplateToggleResponse };
          setMessage(resolveTemplateConfirmation(data) ?? '');
        }
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Failed to update. Please try again.'));
      }
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
