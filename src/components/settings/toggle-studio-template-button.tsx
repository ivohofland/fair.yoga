'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import {
  resolveStudioConfirmation,
  UNREADABLE_CONFIRMATION_MESSAGE,
  type StudioTemplateToggleResponse,
} from './template-action-messages';

interface ToggleStudioTemplateButtonProps {
  templateId: string;
  isActive: boolean;
}

export function ToggleStudioTemplateButton({ templateId, isActive }: ToggleStudioTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      // Derived beside the label below, from the same prop, so the two cannot
      // disagree about which direction this click means.
      const target = isActive ? 'paused' : 'active';
      let res: Response;
      try {
        res = await fetch(`/api/studio-class-templates/${templateId}?state=${target}`, {
          method: 'PATCH',
        });
      } catch {
        setError('Network error. Please try again.');
        return;
      }

      if (res.ok) {
        try {
          const { data } = (await res.json()) as { data: StudioTemplateToggleResponse };
          setMessage(resolveStudioConfirmation(data) ?? '');
        } catch {
          // #193: past res.ok the mutation committed server-side. An unreadable
          // body (proxy truncation, malformed JSON) must not claim network
          // failure or skip router.refresh(), which would leave the UI stale
          // and turn an idempotent retry into silence.
          setMessage(UNREADABLE_CONFIRMATION_MESSAGE);
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
          ? (isActive ? 'Pausing...' : 'Resuming...')
          : (isActive ? 'Pause studio class' : 'Resume studio class')}
      </button>
      {error && <p role="alert" className="text-sm text-danger mt-2">{error}</p>}
      {message && <p className="type-caption mt-2">{message}</p>}
    </div>
  );
}
