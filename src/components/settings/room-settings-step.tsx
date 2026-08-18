import { useState } from 'react';
import type { RoomResult } from '@/lib/room-search';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatRoomLocation } from '@/lib/format';

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
