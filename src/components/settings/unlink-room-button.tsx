'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface UnlinkRoomButtonProps {
  teacherRoomId: string;
  roomName: string;
}

export function UnlinkRoomButton({ teacherRoomId, roomName }: UnlinkRoomButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');

  async function handleUnlink() {
    setRemoving(true);
    setError('');
    try {
      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/settings/rooms');
      } else {
        setError('Failed to unlink room. Please try again.');
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
        className="text-error text-sm"
      >
        Unlink room
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-brown">Unlink {roomName}? Classes using this room will also be removed.</p>
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleUnlink} disabled={removing}>
          {removing ? 'Unlinking...' : 'Unlink'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
