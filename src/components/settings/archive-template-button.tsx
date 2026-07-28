'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { archiveMessage } from './template-action-messages';

interface ArchiveTemplateButtonProps {
  templateId: string;
  isArchived: boolean;
}

/**
 * Shape of the `data` payload on a successful archive/un-archive PATCH.
 *
 * A union, not two optional numbers: un-archiving deletes nothing and the
 * route omits the counts entirely rather than sending zeros that would read
 * like a real archive matching nothing. Discriminating on `action` also means
 * the confirmation follows what the server actually did, rather than the
 * `isArchived` prop captured at the last render — which a second tab can
 * leave stale.
 */
type ArchiveTemplateResponse =
  | { action: 'archived'; deleted: number; remaining: number }
  | { action: 'unarchived' };

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
      const res = await fetch(`/api/class-templates/${templateId}?action=archive`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: ArchiveTemplateResponse };

        // Only the archiving direction gets a message — un-archiving deletes
        // nothing and needs no explanation.
        if (data.action === 'archived') {
          setMessage(archiveMessage(data.deleted, data.remaining));
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
          : (isArchived ? 'Unarchive recurring class' : 'Archive recurring class')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
      {message && <p className="type-caption mt-2">{message}</p>}
    </div>
  );
}
