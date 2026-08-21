'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface DeleteStudioClassButtonProps {
  studioClassId: string;
  /**
   * What this removal takes off the teacher's reported earnings, or null when
   * the class is outside reporting's window.
   *
   * COMPUTED BY THE PAGE, from REPORTING'S predicate — `cancelledAt === null`
   * and `date <= endOfToday` (`settings/reporting/page.tsx:36`) — NOT from the
   * removability one. The two overlap heavily and are not the same: a
   * future-dated manual class is removable and counts nothing, and a class
   * dated today whose start has passed is removable and counts. Deriving this
   * from `deletable` would be wrong in both of those directions.
   */
  earningsAtRisk: number | null;
}

/**
 * The second destructive door on the studio class page, beside "Cancel class"
 * (issue 279). The word is REMOVE, not DELETE, so the page carries one
 * destructive verb per action rather than two that read alike; the HTTP verb
 * stays `DELETE`.
 *
 * Naming the cost before the click mirrors the archive door, whose `remaining`
 * count exists for exactly one confirmation message and is deliberately never
 * persisted (`prisma/schema.prisma`, `withdrawnCount`).
 *
 * `router.push('/')` and not `refresh()`, unlike `CancelStudioClassButton`
 * beside it: the page this button lives on no longer exists after a success.
 * Same choice `DeleteRoomButton` makes. The confirm-then-silence failure that
 * button's sibling documents applies here too — the teacher has already
 * answered "yes, remove it", so an unchanged page reads as success.
 */
export function DeleteStudioClassButton({
  studioClassId,
  earningsAtRisk,
}: DeleteStudioClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');

  // Built as one string rather than conditional JSX so it is one text node —
  // a split node is what makes `getByText` on a whole sentence fail.
  const confirmText =
    earningsAtRisk === null
      ? 'Remove this class? This cannot be undone.'
      : `Remove this class? €${earningsAtRisk.toFixed(2)} will come off your reported earnings. This cannot be undone.`;

  async function handleRemove() {
    setRemoving(true);
    setError('');
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/');
      } else {
        setError(await readErrorMessage(res, 'Could not remove the class. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="type-label text-danger"
      >
        Remove this class
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="type-body">{confirmText}</p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleRemove} disabled={removing}>
          {removing ? 'Removing...' : 'Remove'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
      {error && <p className="type-caption text-danger">{error}</p>}
    </div>
  );
}
