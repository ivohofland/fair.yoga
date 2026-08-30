'use client';

import { useRef, useState } from 'react';
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
 * The duplicate pre-check, as one value rather than two flags.
 *
 * An earlier version held `matches: RoomResult[] | null` beside
 * `checkFailed: boolean`, which is three real states in two fields: it admits
 * the meaningless `(null, true)`, and it encoded "the check failed" by
 * writing an empty array the code had not observed, purely so the confirm
 * button's `matches === null` test would stay false. Two readers then
 * depended on `matches === null` for two different reasons. One value with a
 * discriminant removes both hazards.
 */
type CheckState =
  | { phase: 'searching' }
  | { phase: 'done'; rooms: RoomResult[] }
  | { phase: 'failed'; reason: 'http' | 'network' };

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
  const [check, setCheck] = useState<CheckState>({ phase: 'searching' });
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState('');

  // Which open a resolving search belongs to. Cancel-then-reopen leaves the
  // first search in flight; without this it lands in the second panel and
  // shows the teacher an all-clear that was computed for a session they
  // already abandoned.
  const openId = useRef(0);

  async function handleOpen() {
    const id = ++openId.current;
    setConfirming(true);
    setError('');
    setCheck({ phase: 'searching' });

    const outcome = await searchPublicRooms(postcode, identity.address);
    if (id !== openId.current) return;

    setCheck(
      outcome.ok
        // A failed lookup must not block the action — the route refuses a real
        // collision regardless. But it must not be silent either: rendering it
        // as "no matches" is indistinguishable from a genuinely empty address,
        // so the teacher would read a failed check as an all-clear.
        ? { phase: 'done', rooms: outcome.rooms }
        : { phase: 'failed', reason: outcome.reason },
    );
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

      const json: { error?: { code?: string; message?: string } } = await res.json();

      // ALREADY_SHARED is not a failure — it is the server reporting that the
      // room is already in the state we asked for. The realistic way to reach
      // it is a first attempt that committed and whose response was lost: the
      // teacher saw "Network error", the page never refreshed because
      // `router.refresh()` is on the success path only, so the button is still
      // there and they press it again. Painting this red would tell them their
      // (successful) share failed twice, about a one-way door. Reconcile with
      // the server instead — the same principle use-payment-actions.ts states
      // for a committed undo.
      if (json.error?.code === 'ALREADY_SHARED') {
        router.refresh();
        return;
      }

      // NOT_ROOM_CREATOR and NOT_FOUND both mean this page is describing a row
      // that no longer looks the way it was rendered. Show the reason, and
      // refresh so the controls stop offering an action that cannot succeed.
      setError(json.error?.message ?? 'Failed to share this room.');
      if (json.error?.code === 'NOT_ROOM_CREATOR' || json.error?.code === 'NOT_FOUND') {
        router.refresh();
      }
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

  const rooms = check.phase === 'done' ? check.rooms : [];
  const exact = findIdentityMatch(rooms, identity);

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
          {/*
            The two reasons need different sentences. 'network' is a lost
            request, so the write may well succeed — "sharing still works" is
            true. 'http' from this endpoint is realistically a 401 (the
            session expired) or a 5xx, and in both the write is about to hit
            the same wall, so promising it works would be a false statement
            about the very next action.
          */}
          {check.phase === 'failed' && check.reason === 'network' && (
            <p className="text-brown text-sm">
              Could not check for rooms already shared at this address. Sharing still
              works — a duplicate is refused when you confirm.
            </p>
          )}
          {check.phase === 'failed' && check.reason === 'http' && (
            <p className="text-brown text-sm">
              Could not check for rooms already shared at this address. You may need to
              sign in again.
            </p>
          )}
          {rooms.length > 0 && (
            <>
              <p className="text-ink text-sm font-semibold">Rooms already shared at this address</p>
              <RoomMatchList rooms={rooms} />
              <p className="text-brown text-sm">
                If one of these is the same room, there&apos;s no need to share yours.
              </p>
            </>
          )}
          <PublicRoomNotice />
        </>
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <div className="flex gap-3">
        {!exact && (
          <Button onClick={handleShare} disabled={sharing || check.phase === 'searching'}>
            {sharing ? 'Sharing...' : 'Share room'}
          </Button>
        )}
        <Button
          variant="secondary"
          onClick={() => { openId.current++; setConfirming(false); setCheck({ phase: 'searching' }); }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
