'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface ToggleTemplateButtonProps {
  templateId: string;
  isActive: boolean;
}

export function ToggleTemplateButton({ templateId, isActive }: ToggleTemplateButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleToggle() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/class-templates/${templateId}`, { method: 'PATCH' });
      if (res.ok) {
        router.push('/settings/recurring');
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
          ? (isActive ? 'Pausing...' : 'Resuming...')
          : (isActive ? 'Pause recurring class' : 'Resume recurring class')}
      </button>
      {error && <p className="text-sm text-error mt-2">{error}</p>}
    </div>
  );
}
