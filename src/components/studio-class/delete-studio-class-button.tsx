'use client';

import { useState } from 'react';
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
 * Leaves for the schedule with a hard navigation, not `router.push('/')`: the
 * detail page no longer exists after a success, and a soft push serves the back
 * link's stale prefetch of the schedule (verified in the running app — see the
 * inline comment on `window.location.assign` below). The same move
 * `DeleteRoomButton` makes to its own list page, which since this branch does
 * it the same way for the same measured reason.
 *
 * The confirm-then-silence failure applies here too — the teacher has already
 * answered "yes, remove it", so an unchanged page reads as success. That is why
 * `removing` is NOT cleared on the success path: the navigation is in flight,
 * and re-enabling the button under it would show an idle "Remove" on a page
 * that is leaving.
 */
export function DeleteStudioClassButton({
  studioClassId,
  earningsAtRisk,
}: DeleteStudioClassButtonProps) {
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

    let removed = false;
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, { method: 'DELETE' });
      if (res.ok) removed = true;
      else setError(await readErrorMessage(res, 'Could not remove the class. Please try again.'));
    } catch {
      setError('Network error. Please try again.');
    }

    if (removed) {
      // A hard exit, deliberately. The page's back link usually has '/' already
      // prefetched by the time the removal lands, and a soft `router.push('/')`
      // serves that pre-removal prefetch entry — the removed row kept rendering
      // in the running app past a 4s settle window, with `router.refresh()`
      // before or after the push (refresh revalidates the route being left, not
      // the destination's cache entry). A full navigation cannot serve the old
      // schedule.
      //
      // Outside the `try` on purpose: inside it, a throw here would report a
      // removal the server COMMITTED as "Network error. Please try again.", and
      // the retry would then answer 404. `removing` is left set — the page is
      // going away, and an enabled "Remove" under an in-flight navigation is
      // the silence half of confirm-then-silence.
      window.location.assign('/');
      return;
    }

    setRemoving(false);
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
