'use client';

import { useState } from 'react';
import type { RoomResult, RoomSearchOutcome } from '@/lib/room-search';
import type { NoneOf } from '@/lib/type-pins';
import { searchPublicRooms } from '@/lib/room-search';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RoomMatchList } from './room-match-list';

interface RoomSearchStepProps {
  postcode: string;
  street: string;
  /** Owned by the router: this step unmounts on every step change. */
  results: RoomResult[] | null;
  onResultsChange: (rooms: RoomResult[] | null) => void;
  onPostcodeChange: (v: string) => void;
  onStreetChange: (v: string) => void;
  onSelect: (room: RoomResult) => void;
  onCreateNew: () => void;
}

export function RoomSearchStep({
  postcode, street, results, onResultsChange,
  onPostcodeChange, onStreetChange, onSelect, onCreateNew,
}: RoomSearchStepProps) {
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!postcode.trim() || !street.trim()) return;

    setSearching(true);
    onResultsChange(null);
    setSearchError('');

    // `searchPublicRooms` returns its failure rather than throwing it, so the
    // two cases cannot be collapsed into one `catch` — which is what happened
    // when this call was first extracted, and what these strings were before.
    const outcome = await searchPublicRooms(postcode, street);
    if (outcome.ok) {
      onResultsChange(outcome.rooms);
    } else {
      // The ternary below handles the union's two members by name, so adding
      // a third would silently route it to the network message — re-creating
      // the exact collapse this union was introduced to make impossible. The
      // pin makes that a compile error instead: it resolves to `true` while
      // the failure reasons are exactly these two, and to the unhandled
      // member's own name as soon as one is added.
      const _reasonsHandled: NoneOf<
        Exclude<Extract<RoomSearchOutcome, { ok: false }>['reason'], 'http' | 'network'>
      > = true;
      void _reasonsHandled;

      setSearchError(
        outcome.reason === 'http'
          ? 'Search failed. Please try again.'
          : 'Network error. Please try again.',
      );
    }
    setSearching(false);
  }

  return (
    <>
      <form onSubmit={handleSearch} className="flex flex-col gap-4 mb-6">
        <Input
          label="Postcode"
          value={postcode}
          onChange={(e) => onPostcodeChange(e.target.value)}
          placeholder="e.g. 1018 DT"
        />
        <Input
          label="Street"
          value={street}
          onChange={(e) => onStreetChange(e.target.value)}
          placeholder="e.g. Keizersgracht"
        />
        <Button type="submit" disabled={searching || !postcode.trim() || !street.trim()}>
          {searching ? 'Searching...' : 'Search'}
        </Button>
      </form>

      {searchError && <p className="text-sm text-danger mb-4">{searchError}</p>}

      {results !== null && (
        <div>
          {results.length > 0 ? (
            <>
              <p className="text-sm text-brown mb-3">Existing rooms found:</p>
              <RoomMatchList rooms={results} onSelect={onSelect} />
              <button
                type="button"
                onClick={onCreateNew}
                className="text-teal text-sm"
              >
                Or create a new room at this address
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-brown mb-3">No rooms found at this address.</p>
              <button
                type="button"
                onClick={onCreateNew}
                className="text-teal text-sm"
              >
                Create new room
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
