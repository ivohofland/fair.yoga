'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { createTeacherRoomSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import type { RoomResult } from '@/lib/room-search';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatRoomLocation } from '@/lib/format';

/**
 * #136. This step's enumeration of the teacher-room link it posts. Beside its
 * literal, and annotating it, for the reason given in `room-create-step.tsx`.
 *
 * This one had lost more than the annotation: for one commit on this branch
 * (`7afcb84`) the body was inlined straight into `JSON.stringify({ … })`, so
 * there was no literal left to pin at all. On `main` it was a proper
 * annotated literal in `add-room-flow.tsx` — the loss was the extraction's,
 * not a pre-existing state.
 */
interface NewTeacherRoomValues {
  roomId: string;
  capacityOverride: number;
  rentalRate: number;
  equipmentNotes: string | null;
}

type CreateTeacherRoomWire = z.infer<typeof createTeacherRoomSchema>;

// Value types as well as key names — see room-create-step.tsx.
const _linkIsWireShaped: CreateTeacherRoomWire = null as unknown as NewTeacherRoomValues;
void _linkIsWireShaped;

const _linkCoversCreate: NoneOf<Exclude<keyof CreateTeacherRoomWire, keyof NewTeacherRoomValues>> = true;
const _linkHasNoExtras: NoneOf<Exclude<keyof NewTeacherRoomValues, keyof CreateTeacherRoomWire>> = true;
void _linkCoversCreate;
void _linkHasNoExtras;

interface RoomSettingsStepProps {
  selectedRoom: RoomResult;
  onSaved: () => void;
  onBack: () => void;
}

export function RoomSettingsStep({ selectedRoom, onSaved, onBack }: RoomSettingsStepProps) {
  const [capacityOverride, setCapacityOverride] = useState(String(selectedRoom.maxCapacity));
  const [rentalRate, setRentalRate] = useState('');
  const [equipmentNotes, setEquipmentNotes] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();

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
      const newTeacherRoom: NewTeacherRoomValues = {
        roomId: selectedRoom.id,
        capacityOverride: cap,
        rentalRate: rate,
        equipmentNotes: equipmentNotes.trim() || null,
      };

      const res = await fetch('/api/teacher-rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTeacherRoom),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setSettingsError(json.error?.message ?? 'Failed to link room');
        return;
      }

      onSaved();
    } catch {
      setSettingsError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="mb-6 pb-4 border-b border-border">
        <p className="text-base text-ink">
          {formatRoomLocation(selectedRoom.roomName, selectedRoom.venueName)}
        </p>
        <p className="type-caption">{selectedRoom.address}, {selectedRoom.city}</p>
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

        {settingsError && <p className="text-sm text-danger">{settingsError}</p>}

        <div className="flex justify-between mt-4">
          <Button variant="secondary" type="button" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Add room'}
          </Button>
        </div>
      </form>
    </>
  );
}
