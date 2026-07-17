'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const EQUIPMENT_OPTIONS = [
  { key: 'mats', label: 'Mats' },
  { key: 'blocks', label: 'Blocks' },
  { key: 'straps', label: 'Straps' },
  { key: 'bolsters', label: 'Bolsters' },
  { key: 'blankets', label: 'Blankets' },
  { key: 'cushions', label: 'Meditation cushions' },
];

interface EditRoomFormProps {
  roomId: string;
  teacherRoomId: string;
  initial: {
    venueName: string;
    roomName: string;
    address: string;
    city: string;
    postcode: string;
    floor: string;
    maxCapacity: number;
    equipment: string[];
    notes: string;
    rentalRate: number;
  };
}

export function EditRoomForm({ roomId, teacherRoomId, initial }: EditRoomFormProps) {
  const router = useRouter();
  const [venueName, setVenueName] = useState(initial.venueName);
  const [roomName, setRoomName] = useState(initial.roomName);
  const [address, setAddress] = useState(initial.address);
  const [city, setCity] = useState(initial.city);
  const [postcode, setPostcode] = useState(initial.postcode);
  const [floor, setFloor] = useState(initial.floor);
  const [maxCapacity, setMaxCapacity] = useState(String(initial.maxCapacity));
  const [equipment, setEquipment] = useState<Record<string, boolean>>(
    Object.fromEntries(EQUIPMENT_OPTIONS.map(({ key }) => [key, initial.equipment.includes(key)]))
  );
  const [notes, setNotes] = useState(initial.notes);
  const [rentalRate, setRentalRate] = useState(String(initial.rentalRate));
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!venueName.trim()) {
      setError('Venue name is required');
      return;
    }
    if (!address.trim()) {
      setError('Address is required');
      return;
    }
    const cap = Number(maxCapacity);
    if (!cap || cap <= 0) {
      setError('Max capacity must be a positive number');
      return;
    }
    const rate = Number(rentalRate);
    if (isNaN(rate) || rate < 0) {
      setError('Rental rate must be 0 or more');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const notesValue = notes.trim() || null;

      const res = await fetch(`/api/rooms/${roomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueName: venueName.trim(),
          roomName: roomName.trim(),
          address: address.trim(),
          city: city.trim(),
          postcode: postcode.trim(),
          floor: floor.trim(),
          maxCapacity: cap,
          equipment: Object.entries(equipment)
            .filter(([, checked]) => checked)
            .map(([key]) => key),
          notes: notesValue,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
        return;
      }

      // Sync capacity, notes, and rental rate to teacher-room
      const trRes = await fetch(`/api/teacher-rooms/${teacherRoomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capacityOverride: cap,
          rentalRate: rate,
          equipmentNotes: notesValue,
        }),
      });

      if (!trRes.ok) {
        const json: { error?: { message?: string } } = await trRes.json();
        setError(json.error?.message ?? 'Failed to save settings');
        return;
      }

      setSuccess('Saved');
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function clearSuccess() {
    setSuccess('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input label="Venue name" value={venueName} onChange={(e) => { setVenueName(e.target.value); clearSuccess(); }} />
      <Input label="Room name" value={roomName} onChange={(e) => { setRoomName(e.target.value); clearSuccess(); }} placeholder="e.g. Main Studio" />
      <Input label="Address" value={address} onChange={(e) => { setAddress(e.target.value); clearSuccess(); }} />
      <Input label="City" value={city} onChange={(e) => { setCity(e.target.value); clearSuccess(); }} />
      <Input label="Postcode" value={postcode} onChange={(e) => { setPostcode(e.target.value); clearSuccess(); }} />
      <Input label="Floor" value={floor} onChange={(e) => { setFloor(e.target.value); clearSuccess(); }} placeholder="e.g. Ground, 1st" />
      <Input label="Max capacity" type="number" value={maxCapacity} onChange={(e) => { setMaxCapacity(e.target.value); clearSuccess(); }} />
      <Input label="Rental rate" type="number" step="0.01" value={rentalRate} onChange={(e) => { setRentalRate(e.target.value); clearSuccess(); }} />

      <fieldset className="flex flex-col gap-1">
        <legend className="text-brown mb-2">Available props</legend>
        {EQUIPMENT_OPTIONS.map(({ key, label }) => (
          <label key={key} className="flex items-center gap-3 min-h-[44px]">
            <input
              type="checkbox"
              checked={equipment[key] ?? false}
              onChange={(e) => { setEquipment((prev) => ({ ...prev, [key]: e.target.checked })); clearSuccess(); }}
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
          onChange={(e) => { setNotes(e.target.value); clearSuccess(); }}
          rows={3}
          placeholder="e.g. key code for entrance, bring your own mat"
          className="bg-sand-soft border border-border rounded-field px-4 py-3 min-h-24 text-ink text-base focus:outline-none focus:shadow-focus w-full"
        />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
