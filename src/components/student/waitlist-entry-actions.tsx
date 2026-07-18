'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface WaitlistEntryActionsProps {
  entryId: string;
  classId: string;
  /** True during the first-come-first-claimed window with a free seat. */
  canClaim: boolean;
}

/**
 * Claim an open spot (final hour before the deadline — first claim wins)
 * or leave the waitlist.
 */
export function WaitlistEntryActions({ entryId, classId, canClaim }: WaitlistEntryActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<'claim' | 'leave' | null>(null);
  const [error, setError] = useState('');

  async function handleClaim() {
    setBusy('claim');
    setError('');
    try {
      const res = await fetch('/api/waitlist/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not claim the spot. Try again.'));
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handleLeave() {
    setBusy('leave');
    setError('');
    try {
      const res = await fetch(`/api/waitlist/${entryId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not leave the waitlist. Try again.'));
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {canClaim && (
        <div>
          <p className="type-caption text-teal mb-2">
            A spot opened up — the first to claim it gets it.
          </p>
          <Button onClick={handleClaim} disabled={busy !== null}>
            {busy === 'claim' ? 'Claiming...' : 'Claim the spot'}
          </Button>
        </div>
      )}
      <button
        type="button"
        onClick={handleLeave}
        disabled={busy !== null}
        className="type-label text-danger self-start disabled:opacity-50"
      >
        {busy === 'leave' ? 'Leaving...' : 'Leave waitlist'}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
