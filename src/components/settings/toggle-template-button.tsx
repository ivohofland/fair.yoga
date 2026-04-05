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

  async function handleToggle() {
    setLoading(true);
    try {
      const res = await fetch(`/api/class-templates/${templateId}`, { method: 'PATCH' });
      if (res.ok) {
        router.push('/settings/recurring');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
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
  );
}
