'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface EditTeacherRoomFormProps {
  teacherRoomId: string;
  maxCapacity: number;
  initial: {
    capacityOverride: number;
    rentalRate: number;
    equipmentNotes: string;
  };
}

export function EditTeacherRoomForm({
  teacherRoomId,
  maxCapacity,
  initial,
}: EditTeacherRoomFormProps) {
  const router = useRouter();
  const [capacityOverride, setCapacityOverride] = useState(String(initial.capacityOverride));
  const [rentalRate, setRentalRate] = useState(String(initial.rentalRate));
  const [equipmentNotes, setEquipmentNotes] = useState(initial.equipmentNotes);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cap = Number(capacityOverride);
    const rate = Number(rentalRate);

    if (!cap || cap <= 0) {
      setError('Capacity must be a positive number');
      return;
    }
    if (cap > maxCapacity) {
      setError(`Capacity cannot exceed room maximum (${maxCapacity})`);
      return;
    }
    if (isNaN(rate) || rate < 0) {
      setError('Rental rate must be 0 or more');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capacityOverride: cap,
          rentalRate: rate,
          equipmentNotes: equipmentNotes.trim() || null,
        }),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
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

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label={`Capacity override (max ${maxCapacity})`}
        type="number"
        value={capacityOverride}
        onChange={(e) => { setCapacityOverride(e.target.value); setSuccess(''); }}
      />
      <Input
        label="Rental rate"
        type="number"
        step="0.01"
        value={rentalRate}
        onChange={(e) => { setRentalRate(e.target.value); setSuccess(''); }}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="equipmentNotes" className="text-brown">Equipment notes</label>
        <textarea
          id="equipmentNotes"
          value={equipmentNotes}
          onChange={(e) => { setEquipmentNotes(e.target.value); setSuccess(''); }}
          rows={3}
          className="bg-cream border border-teal rounded-none px-4 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full"
        />
      </div>

      {error && <p className="text-sm text-error">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
