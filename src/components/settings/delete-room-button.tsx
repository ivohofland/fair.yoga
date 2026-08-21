'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface DeleteRoomButtonProps {
  roomId: string;
  roomName: string;
}

export function DeleteRoomButton({ roomId, roomName }: DeleteRoomButtonProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setError('');

    let deleted = false;
    try {
      const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
      if (res.ok) {
        deleted = true;
      } else {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to delete room.');
      }
    } catch {
      setError('Network error. Please try again.');
    }

    if (deleted) {
      // A hard navigation, matching `DeleteStudioClassButton` and for the same
      // measured reason: on Next 16 a soft `router.push` to a list the deleted
      // row was on serves the destination's pre-deletion prefetch, so the room
      // keeps rendering for a moment after a delete the server committed. That
      // flash reads as "the delete failed". Measured under issue 279 while
      // probing the studio-class door; folded in here because it is the same
      // defect on a second surface, not a different one.
      //
      // `deleting` is deliberately left set — the page is leaving.
      window.location.assign('/settings/rooms');
      return;
    }

    setDeleting(false);
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-danger text-sm"
      >
        Delete room
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-brown">Permanently delete {roomName}? This cannot be undone.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
          {deleting ? 'Deleting...' : 'Delete'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
