'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { resolveStudioConfirmation, type StudioTemplateToggleResponse } from './template-action-messages';

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
      const res = await fetch(`/api/studio-class-templates/${templateId}?state=${target}`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: StudioTemplateToggleResponse };
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
          ? (isActive ? 'Pausing...' : 'Resuming...')
          : (isActive ? 'Pause studio class' : 'Resume studio class')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
      {message && <p className="type-caption mt-2">{message}</p>}
    </div>
  );
}
