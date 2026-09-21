'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readError } from '@/lib/client-errors';

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
        const { code, message } = await readError(res, 'Failed to unlink room. Please try again.');
        // The link being gone is what this unlink asked for, whoever removed it.
        if (code === 'NOT_FOUND') router.push('/settings/rooms');
        else setError(message);
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
        className="text-danger text-sm"
      >
        Unlink room
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-brown">Unlink {roomName}? This removes it from your rooms. Only possible while no classes use it.</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
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
