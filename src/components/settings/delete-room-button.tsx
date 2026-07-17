'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface DeleteRoomButtonProps {
  roomId: string;
  roomName: string;
}

export function DeleteRoomButton({ roomId, roomName }: DeleteRoomButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function handleDelete() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/rooms/${roomId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/settings/rooms');
      } else {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to delete room.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setDeleting(false);
    }
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
