'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { archiveStudioMessage } from './template-action-messages';

interface ArchiveStudioTemplateButtonProps {
  templateId: string;
  isArchived: boolean;
}

/** Shape of the `data` payload on a successful archive/un-archive PATCH. */
interface ArchiveStudioTemplateResponse {
  deleted: number;
  remaining: number;
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
      const res = await fetch(`/api/studio-class-templates/${templateId}?action=archive`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: ArchiveStudioTemplateResponse };

        // Only the archiving direction gets a message — un-archiving deletes
        // nothing and needs no explanation.
        if (!isArchived) {
          setMessage(archiveStudioMessage(data.deleted, data.remaining));
        }
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
