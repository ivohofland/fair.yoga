'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { pauseMessage } from './template-action-messages';

interface ToggleTemplateButtonProps {
  templateId: string;
  isActive: boolean;
}

/** Shape of the `data` payload on a successful toggle (pause/resume) PATCH. */
interface ToggleTemplateResponse {
  lastScheduled: { date: string; startTime: string } | null;
}

export function ToggleTemplateButton({ templateId, isActive }: ToggleTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch(`/api/class-templates/${templateId}`, { method: 'PATCH' });
      if (res.ok) {
        const { data } = (await res.json()) as { data: ToggleTemplateResponse };

        // Only the pause direction gets a message — resuming needs no explanation.
        if (isActive) {
          const last = data.lastScheduled;
          setMessage(pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null));
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
          ? (isActive ? 'Pausing...' : 'Resuming...')
          : (isActive ? 'Pause recurring class' : 'Resume recurring class')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
      {message && <p className="type-caption mt-2">{message}</p>}
    </div>
  );
}
