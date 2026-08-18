'use client';

import { useState } from 'react';
import type { RoomResult } from '@/lib/room-search';
import { searchPublicRooms } from '@/lib/room-search';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RoomMatchList } from './room-match-list';

interface RoomSearchStepProps {
  postcode: string;
  street: string;
  onPostcodeChange: (v: string) => void;
  onStreetChange: (v: string) => void;
  onSelect: (room: RoomResult) => void;
  onCreateNew: () => void;
}

export function RoomSearchStep({ postcode, street, onPostcodeChange, onStreetChange, onSelect, onCreateNew }: RoomSearchStepProps) {
  const [results, setResults] = useState<RoomResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!postcode.trim() || !street.trim()) return;

    setSearching(true);
    setResults(null);
    setSearchError('');
    try {
      setResults(await searchPublicRooms(postcode, street));
    } catch {
      setSearchError('Network error. Please try again.');
    } finally {
      setSearching(false);
    }
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
