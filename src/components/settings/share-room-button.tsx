'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { PublicRoomNotice } from './public-room-notice';
import { RoomMatchList } from './room-match-list';
import { searchPublicRooms, type RoomResult } from '@/lib/room-search';
import { findIdentityMatch, type RoomIdentity } from '@/lib/room-identity';

interface ShareRoomButtonProps {
  roomId: string;
  identity: RoomIdentity;
  postcode: string;
}

/**
 * Sharing a room, as a two-step inline confirm — the same shape as
 * DeleteRoomButton, and for the same reason: the action is irreversible.
 *
 * The duplicate search runs on OPEN, client-side, not as a server prop. A
 * server-rendered "nothing shared here" goes stale the moment another teacher
 * shares a colliding room, and this control must not be gated on a snapshot a
 * concurrent write can invalidate. The route's DUPLICATE_ROOM stays the
 * authority; this pre-check exists to replace an error with a branch.
 *
 * Switching to a room that already holds the identity is #259, not built —
 * which is why RoomMatchList is rendered without `onSelect` here.
 */
export function ShareRoomButton({ roomId, identity, postcode }: ShareRoomButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [matches, setMatches] = useState<RoomResult[] | null>(null);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');

  async function handleOpen() {
    setConfirming(true);
    setError('');
    try {
      setMatches(await searchPublicRooms(postcode, identity.address));
    } catch {
      // A failed lookup must not block the action — the route refuses a real
      // collision regardless. Show nothing rather than a false all-clear.
      setMatches([]);
    }
  }

  async function handleShare() {
    setSharing(true);
    setError('');
    try {
      const res = await fetch(`/api/rooms/${roomId}/publish`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const json: { error?: { message?: string } } = await res.json();
      setError(json.error?.message ?? 'Failed to share this room.');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSharing(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" onClick={handleOpen} className="text-teal text-sm text-left">
        Share with other teachers
      </button>
    );
  }

  const exact = matches ? findIdentityMatch(matches, identity) : undefined;

  return (
    <div className="flex flex-col gap-3">
      {exact ? (
        <>
          <p className="text-ink text-sm font-semibold">Already shared</p>
          <p className="text-brown text-sm">
            {exact.roomName || exact.venueName} at {exact.address} is already shared with all
            teachers. You don&apos;t need to share yours — you can add it from
            Settings › Rooms › Add room.
          </p>
        </>
      ) : (
        <>
          {matches && matches.length > 0 && (
            <>
              <p className="text-ink text-sm font-semibold">Rooms already shared at this address</p>
              <RoomMatchList rooms={matches} />
              <p className="text-brown text-sm">
                If one of these is the same room, there&apos;s no need to share yours.
              </p>
            </>
          )}
          <PublicRoomNotice />
        </>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        {!exact && (
          <Button onClick={handleShare} disabled={sharing || matches === null}>
            {sharing ? 'Sharing...' : 'Share room'}
          </Button>
        )}
        <Button variant="secondary" onClick={() => { setConfirming(false); setMatches(null); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
