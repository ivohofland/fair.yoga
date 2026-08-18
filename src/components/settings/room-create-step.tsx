'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { createRoomSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import type { RoomResult } from '@/lib/room-search';
import type { NewRoomForm } from './add-room-flow';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PublicRoomNotice } from './public-room-notice';

/**
 * #136. This step's enumeration of the room it posts.
 *
 * The pin lives here, beside the literal it describes, and the literal is
 * annotated with it — that annotation is the whole mechanism, because it is
 * TypeScript's excess-property check on an annotated object literal that
 * makes the pin bite. The pair used to sit in `add-room-flow.tsx`; when the
 * create step was extracted, the literal moved and the pin did not, so for
 * one commit the pin still compiled while guarding a body nothing sent. A pin
 * separated from its literal reports success either way, which is the failure
 * mode pins exist to remove. Keep them in the same file.
 */
interface NewRoomValues {
  venueName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  roomName: string;
  maxCapacity: number;
  equipment: string[];
  notes: string | null;
  isPublic: boolean;
}

type CreateRoomWire = z.infer<typeof createRoomSchema>;

// The two pins above compare key NAMES only — `keyof` cannot see types, so
// `maxCapacity: '12'` satisfies both and is a 400 at runtime. This third pin
// adds the direction that matters: the literal must be something the schema
// would accept.
const _roomIsWireShaped: CreateRoomWire = null as unknown as NewRoomValues;
void _roomIsWireShaped;

const _roomCoversCreate: NoneOf<Exclude<keyof CreateRoomWire, keyof NewRoomValues>> = true;
const _roomHasNoExtras: NoneOf<Exclude<keyof NewRoomValues, keyof CreateRoomWire>> = true;
void _roomCoversCreate;
void _roomHasNoExtras;

interface RoomCreateStepProps {
  postcode: string;
  street: string;
  /**
   * Owned by the router, because this step unmounts on every step change and
   * a half-filled form must survive Back. See `NewRoomForm` in
   * `add-room-flow.tsx` for why.
   */
  form: NewRoomForm;
  onFormChange: (form: NewRoomForm) => void;
  onPostcodeChange: (v: string) => void;
  onStreetChange: (v: string) => void;
  onCreated: (room: RoomResult) => void;
  onBack: () => void;
}

export function RoomCreateStep({
  postcode, street, form, onFormChange,
  onPostcodeChange, onStreetChange, onCreated, onBack,
}: RoomCreateStepProps) {
  const { venueName, roomName, floor, city, maxCapacity, equipmentChecks, notes, isPublic } = form;
  const set = <K extends keyof NewRoomForm>(key: K, value: NewRoomForm[K]) =>
    onFormChange({ ...form, [key]: value });

  // Transient: these describe one in-flight submission, so losing them when
  // the teacher steps Back is correct.
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

      const newRoom: NewRoomValues = {
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
      <Input label="Venue name" value={venueName} onChange={(e) => set('venueName', e.target.value)} placeholder="e.g. De Yogaschool" />
      <Input label="Address" value={street} onChange={(e) => onStreetChange(e.target.value)} />
      <Input label="City" value={city} onChange={(e) => set('city', e.target.value)} />
      <Input label="Postcode" value={postcode} onChange={(e) => onPostcodeChange(e.target.value)} />
      <Input label="Floor" value={floor} onChange={(e) => set('floor', e.target.value)} placeholder="e.g. Ground, 1st" />
      <Input label="Room name" value={roomName} onChange={(e) => set('roomName', e.target.value)} placeholder="e.g. Main Studio" />
      <Input label="Max capacity" type="number" value={maxCapacity} onChange={(e) => set('maxCapacity', e.target.value)} />
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
              onChange={(e) => set('equipmentChecks', { ...equipmentChecks, [key]: e.target.checked })}
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
          onChange={(e) => set('notes', e.target.value)}
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
            onChange={(e) => set('isPublic', e.target.checked)}
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
