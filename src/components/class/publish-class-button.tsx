'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface PublishClassButtonProps {
  classId: string;
}

export function PublishClassButton({ classId }: PublishClassButtonProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handlePublish() {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/classes/${classId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to publish class.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="py-6">
      {error && <p className="text-sm text-error mb-3">{error}</p>}
      <Button onClick={handlePublish} disabled={submitting}>
        {submitting ? 'Publishing...' : 'Open for registration'}
      </Button>
    </div>
  );
}
