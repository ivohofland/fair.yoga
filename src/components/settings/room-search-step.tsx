'use client';

import { useState } from 'react';
import type { RoomCitySearchOutcome, RoomCitySearchResult, RoomResult } from '@/lib/room-search';
import type { NoneOf } from '@/lib/type-pins';
import { ROOM_CITY_SEARCH_LIMIT, searchRoomsByCity } from '@/lib/room-search';
import { CITY_MAX, ROOM_ADDRESS_MAX } from '@/lib/input-bounds';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RoomMatchList } from './room-match-list';

interface RoomSearchStepProps {
  city: string;
  q: string;
  /** Owned by the router: this step unmounts on every step change. */
  results: RoomCitySearchResult | null;
  /** The `q` that produced `results`; the live `q` may have moved on since. */
  searchedQ: string;
  onResultsChange: (results: RoomCitySearchResult | null, searchedQ: string) => void;
  onCityChange: (v: string) => void;
  onQChange: (v: string) => void;
  onSelect: (room: RoomResult) => void;
  onCreateNew: () => void;
}

export function RoomSearchStep({
  city, q, results, searchedQ, onResultsChange,
  onCityChange, onQChange, onSelect, onCreateNew,
}: RoomSearchStepProps) {
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!city.trim()) return;

    setSearching(true);
    onResultsChange(null, '');
    setSearchError('');

    // `searchRoomsByCity` returns its failure rather than throwing it, so the
    // two cases cannot be collapsed into one `catch` — which is what happened
    // when this call was first extracted, and what these strings were before.
    const outcome = await searchRoomsByCity(city, q);
    if (outcome.ok) {
      onResultsChange({ rooms: outcome.rooms, truncated: outcome.truncated }, q.trim());
    } else {
      // The ternary below handles the union's two members by name, so adding
      // a third would silently route it to the network message — re-creating
      // the exact collapse this union was introduced to make impossible. The
      // pin makes that a compile error instead: it resolves to `true` while
      // the failure reasons are exactly these two, and to the unhandled
      // member's own name as soon as one is added.
      const _reasonsHandled: NoneOf<
        Exclude<Extract<RoomCitySearchOutcome, { ok: false }>['reason'], 'http' | 'network'>
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
          label="City"
          maxLength={CITY_MAX}
          value={city}
          onChange={(e) => { onCityChange(e.target.value); if (searchError) setSearchError(''); }}
          placeholder="e.g. Amsterdam"
        />
        <Input
          label="Street or venue (optional)"
          maxLength={ROOM_ADDRESS_MAX}
          value={q}
          onChange={(e) => { onQChange(e.target.value); if (searchError) setSearchError(''); }}
          placeholder="e.g. Keizersgracht"
        />
        <Button type="submit" disabled={searching || !city.trim()}>
          {searching ? 'Searching...' : 'Search'}
        </Button>
      </form>

      {searchError && <p role="alert" className="text-sm text-danger mb-4">{searchError}</p>}

      {results !== null && (
        <div>
          {results.rooms.length > 0 ? (
            <>
              <p className="text-sm text-brown mb-3">Shared rooms found:</p>
              {results.truncated && (
                <p className="type-caption mb-3">Showing the first {ROOM_CITY_SEARCH_LIMIT}. Add a street or venue to narrow it.</p>
              )}
              <RoomMatchList rooms={results.rooms} onSelect={onSelect} />
              <button
                type="button"
                onClick={onCreateNew}
                className="text-teal text-sm"
              >
                Or create a new room
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-brown mb-3">{searchedQ ? 'No shared rooms match.' : 'No shared rooms found in this city.'}</p>
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
