'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ToggleStudioTemplateButtonProps {
  templateId: string;
  isActive: boolean;
}

export function ToggleStudioTemplateButton({ templateId, isActive }: ToggleStudioTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/studio-class-templates/${templateId}`, { method: 'PATCH' });
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
        className="type-caption"
      >
        {loading
          ? (isActive ? 'Pausing...' : 'Resuming...')
          : (isActive ? 'Pause studio class' : 'Resume studio class')}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
