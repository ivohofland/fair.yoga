'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateTeacherRoomSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface EditTeacherRoomFormProps {
  teacherRoomId: string;
  initial: {
    capacityOverride: number;
    rentalRate: number;
    equipmentNotes: string;
  };
}

type UpdateTeacherRoomWire = z.infer<typeof updateTeacherRoomSchema>;
type EditTeacherRoomValues = EditTeacherRoomFormProps['initial'];

/**
 * #136. `EditTeacherRoomValues` (the `initial` prop's field list) and the
 * payload literal below are two separate enumerations of this form's body;
 * nothing previously checked either against `updateTeacherRoomSchema`.
 *
 * The payload is annotated `Required<UpdateTeacherRoomWire>`, not the wire
 * type itself. Every key in `updateTeacherRoomSchema` is `.optional()` — that
 * lets `PATCH`-style partial updates validate — so the plain wire type
 * requires nothing, and deleting a key from the payload literal would still
 * satisfy it. This form always sends all three keys, so `Required<>` says
 * that: the excess/missing-property check on the annotated literal then
 * catches a dropped key at compile time, which the unwrapped wire type could
 * not.
 */
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateTeacherRoomWire, keyof EditTeacherRoomValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof EditTeacherRoomValues, keyof UpdateTeacherRoomWire>> = true;
void _formCoversUpdate;
void _formHasNoExtras;

export function EditTeacherRoomForm({
  teacherRoomId,
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
    if (isNaN(rate) || rate < 0) {
      setError('Rental rate must be 0 or more');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const payload: Required<UpdateTeacherRoomWire> = {
        capacityOverride: cap,
        rentalRate: rate,
        equipmentNotes: equipmentNotes.trim() || null,
      };

      const res = await fetch(`/api/teacher-rooms/${teacherRoomId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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

  function clearStatus() {
    if (error) setError('');
    if (success) setSuccess('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="Capacity override"
        type="number"
        value={capacityOverride}
        onChange={(e) => { setCapacityOverride(e.target.value); clearStatus(); }}
      />
      <Input
        label="Rental rate"
        type="number"
        step="0.01"
        value={rentalRate}
        onChange={(e) => { setRentalRate(e.target.value); clearStatus(); }}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="equipmentNotes" className="text-brown">Notes</label>
        <textarea
          id="equipmentNotes"
          value={equipmentNotes}
          onChange={(e) => { setEquipmentNotes(e.target.value); clearStatus(); }}
          rows={3}
          className="bg-sand-soft border border-border rounded-field px-4 py-3 min-h-24 text-ink text-base focus:outline-none focus:shadow-focus w-full"
        />
      </div>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
