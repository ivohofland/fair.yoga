'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface RoomResult {
  id: string;
  venueName: string;
  roomName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  maxCapacity: number;
}

type Step = 'search' | 'create' | 'settings';

export function AddRoomFlow() {
  const router = useRouter();

  // Search state
  const [postcode, setPostcode] = useState('');
  const [street, setStreet] = useState('');
  const [results, setResults] = useState<RoomResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Selected or newly created room
  const [selectedRoom, setSelectedRoom] = useState<RoomResult | null>(null);

  // Create room state
  const [venueName, setVenueName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [floor, setFloor] = useState('');
  const [city, setCity] = useState('');
  const [maxCapacity, setMaxCapacity] = useState('');
  const [equipmentChecks, setEquipmentChecks] = useState<Record<string, boolean>>({
    mats: false,
    blocks: false,
    straps: false,
    bolsters: false,
    blankets: false,
    cushions: false,
  });
  const [notes, setNotes] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

  // Settings state
  const [capacityOverride, setCapacityOverride] = useState('');
  const [rentalRate, setRentalRate] = useState('');
  const [equipmentNotes, setEquipmentNotes] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);

  const [step, setStep] = useState<Step>('search');

  // ---- Search ----

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!postcode.trim() || !street.trim()) return;

    setSearching(true);
    setResults(null);
    setSearchError('');
    try {
      const params = new URLSearchParams({
        postcode: postcode.trim(),
        street: street.trim(),
      });
      const res = await fetch(`/api/rooms?${params}`);
      if (!res.ok) {
        setSearchError('Search failed. Please try again.');
        return;
      }
      const json: { data: RoomResult[] } = await res.json();
      setResults(json.data);
    } catch {
      setSearchError('Network error. Please try again.');
    } finally {
      setSearching(false);
    }
  }

  function handleSelectRoom(room: RoomResult) {
    setSelectedRoom(room);
    setCapacityOverride(String(room.maxCapacity));
    setStep('settings');
  }

  function handleCreateNew() {
    setStep('create');
  }

  // ---- Create Room ----

  async function handleCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    if (!venueName.trim() || !city.trim()) {
      setCreateError('Venue name and city are required');
      return;
    }
    const cap = Number(maxCapacity);
    if (!cap || cap <= 0) {
      setCreateError('Max capacity must be a positive number');
      return;
    }

    setCreating(true);
    setCreateError('');

    try {
      const equipmentArray = Object.entries(equipmentChecks)
        .filter(([, v]) => v)
        .map(([k]) => k);

      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueName: venueName.trim(),
          address: street.trim(),
          city: city.trim(),
          postcode: postcode.trim(),
          floor: floor.trim(),
          roomName: roomName.trim(),
          maxCapacity: cap,
          equipment: equipmentArray,
          notes: notes.trim() || null,
          isPublic,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setCreateError(json.error?.message ?? 'Failed to create room');
        return;
      }

      const json: { data: RoomResult } = await res.json();
      setSelectedRoom(json.data);
      setCapacityOverride(String(cap));
      setStep('settings');
    } catch {
      setCreateError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  // ---- Link (Settings) ----

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedRoom) return;

    const cap = Number(capacityOverride);
    const rate = Number(rentalRate);

    if (!cap || cap <= 0) {
      setSettingsError('Capacity must be a positive number');
      return;
    }
    if (cap > selectedRoom.maxCapacity) {
      setSettingsError(`Capacity cannot exceed room maximum (${selectedRoom.maxCapacity})`);
      return;
    }
    if (isNaN(rate) || rate < 0) {
      setSettingsError('Rental rate must be 0 or more');
      return;
    }

    setSaving(true);
    setSettingsError('');

    try {
      const res = await fetch('/api/teacher-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: selectedRoom.id,
          capacityOverride: cap,
          rentalRate: rate,
          equipmentNotes: equipmentNotes.trim() || null,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setSettingsError(json.error?.message ?? 'Failed to link room');
        return;
      }

      router.push('/settings/rooms');
    } catch {
      setSettingsError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ---- Render ----

  return (
    <div>
      {/* Step 1: Search */}
      {step === 'search' && (
        <>
          <form onSubmit={handleSearch} className="flex flex-col gap-4 mb-6">
            <Input
              label="Postcode"
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              placeholder="e.g. 1018 DT"
            />
            <Input
              label="Street"
              value={street}
              onChange={(e) => setStreet(e.target.value)}
              placeholder="e.g. Keizersgracht"
            />
            <Button type="submit" disabled={searching || !postcode.trim() || !street.trim()}>
              {searching ? 'Searching...' : 'Search'}
            </Button>
          </form>

          {searchError && <p className="text-sm text-error mb-4">{searchError}</p>}

          {results !== null && (
            <div>
              {results.length > 0 ? (
                <>
                  <p className="text-sm text-brown mb-3">Existing rooms found:</p>
                  <div className="mb-4">
                    {results.map((room) => (
                      <button
                        key={room.id}
                        type="button"
                        onClick={() => handleSelectRoom(room)}
                        className="w-full text-left flex flex-col gap-1 py-3 border-b border-border"
                      >
                        <span className="text-dark text-sm font-medium">
                          {room.roomName ? `${room.roomName} at ${room.venueName}` : room.venueName}
                        </span>
                        <span className="text-brown text-xs">{room.address}, {room.city}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleCreateNew}
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
                    onClick={handleCreateNew}
                    className="text-teal text-sm"
                  >
                    Create new room
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* Step 1b: Create new room */}
      {step === 'create' && (
        <form onSubmit={handleCreateRoom} className="flex flex-col gap-4">
          <Input label="Venue name" value={venueName} onChange={(e) => setVenueName(e.target.value)} placeholder="e.g. De Yogaschool" />
          <Input label="Address" value={street} onChange={(e) => setStreet(e.target.value)} />
          <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
          <Input label="Postcode" value={postcode} onChange={(e) => setPostcode(e.target.value)} />
          <Input label="Floor" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="e.g. Ground, 1st" />
          <Input label="Room name" value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g. Main Studio" />
          <Input label="Max capacity" type="number" value={maxCapacity} onChange={(e) => setMaxCapacity(e.target.value)} />
          <fieldset className="flex flex-col gap-1">
            <legend className="text-brown mb-2">Available props</legend>
            {[
              { key: 'mats', label: 'Mats' },
              { key: 'blocks', label: 'Blocks' },
              { key: 'straps', label: 'Straps' },
              { key: 'bolsters', label: 'Bolsters' },
              { key: 'blankets', label: 'Blankets' },
              { key: 'cushions', label: 'Meditation cushions' },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-3 min-h-[44px]">
                <input
                  type="checkbox"
                  checked={equipmentChecks[key] ?? false}
                  onChange={(e) => setEquipmentChecks((prev) => ({ ...prev, [key]: e.target.checked }))}
                  className="w-5 h-5 accent-teal"
                />
                <span className="text-dark text-sm">{label}</span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1">
            <label htmlFor="room-notes" className="text-brown">Notes</label>
            <textarea
              id="room-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="e.g. key code for entrance, bring your own mat"
              className="bg-cream border border-teal rounded-none px-4 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full"
            />
          </div>

          <label className="flex items-center gap-3 min-h-[44px]">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
              className="w-5 h-5 accent-teal"
            />
            <span className="text-brown text-sm">Make this room visible to other teachers</span>
          </label>

          {createError && <p className="text-sm text-error">{createError}</p>}

          <div className="flex justify-between mt-4">
            <Button variant="secondary" type="button" onClick={() => setStep('search')}>
              Back
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create room'}
            </Button>
          </div>
        </form>
      )}

      {/* Step 2: Your settings */}
      {step === 'settings' && selectedRoom && (
        <>
          <div className="mb-6 pb-4 border-b border-border">
            <p className="text-dark text-sm font-medium">
              {selectedRoom.roomName} at {selectedRoom.venueName}
            </p>
            <p className="text-brown text-xs">{selectedRoom.address}, {selectedRoom.city}</p>
          </div>

          <form onSubmit={handleSaveSettings} className="flex flex-col gap-4">
            <Input
              label={`Capacity override (max ${selectedRoom.maxCapacity})`}
              type="number"
              value={capacityOverride}
              onChange={(e) => setCapacityOverride(e.target.value)}
            />
            <Input
              label="Rental rate"
              type="number"
              step="0.01"
              value={rentalRate}
              onChange={(e) => setRentalRate(e.target.value)}
            />
            <Input
              label="Notes (optional)"
              value={equipmentNotes}
              onChange={(e) => setEquipmentNotes(e.target.value)}
            />

            {settingsError && <p className="text-sm text-error">{settingsError}</p>}

            <div className="flex justify-between mt-4">
              <Button variant="secondary" type="button" onClick={() => { setSelectedRoom(null); setStep('search'); }}>
                Back
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Add room'}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
