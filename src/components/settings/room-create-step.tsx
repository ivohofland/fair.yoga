'use client';

import { useState } from 'react';
import type { RoomResult } from '@/lib/room-search';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PublicRoomNotice } from './public-room-notice';

interface RoomCreateStepProps {
  postcode: string;
  street: string;
  onPostcodeChange: (v: string) => void;
  onStreetChange: (v: string) => void;
  onCreated: (room: RoomResult) => void;
  onBack: () => void;
}

export function RoomCreateStep({ postcode, street, onPostcodeChange, onStreetChange, onCreated, onBack }: RoomCreateStepProps) {
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
  const [isPublic, setIsPublic] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);

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

      const newRoom = {
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
      };

      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRoom),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setCreateError(json.error?.message ?? 'Failed to create room');
        return;
      }

      const json: { data: RoomResult } = await res.json();
      onCreated(json.data);
    } catch {
      setCreateError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <form onSubmit={handleCreateRoom} className="flex flex-col gap-4">
      <Input label="Venue name" value={venueName} onChange={(e) => setVenueName(e.target.value)} placeholder="e.g. De Yogaschool" />
      <Input label="Address" value={street} onChange={(e) => onStreetChange(e.target.value)} />
      <Input label="City" value={city} onChange={(e) => setCity(e.target.value)} />
      <Input label="Postcode" value={postcode} onChange={(e) => onPostcodeChange(e.target.value)} />
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
            <span className="text-base text-ink">{label}</span>
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
          className="bg-sand-soft border border-border rounded-field px-4 py-3 min-h-24 text-ink text-base focus:outline-none focus:shadow-focus w-full"
        />
      </div>

      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-3 min-h-[44px]">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="w-5 h-5 accent-teal"
          />
          <span className="text-brown text-sm">Share this room with other teachers</span>
        </label>
        <PublicRoomNotice />
      </div>

      {createError && <p className="text-sm text-danger">{createError}</p>}

      <div className="flex justify-between mt-4">
        <Button variant="secondary" type="button" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" disabled={creating}>
          {creating ? 'Creating...' : 'Create room'}
        </Button>
      </div>
    </form>
  );
}
