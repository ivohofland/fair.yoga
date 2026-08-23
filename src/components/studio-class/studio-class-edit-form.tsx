'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { updateStudioClassSchema } from '@/lib/schemas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readErrorMessage } from '@/lib/client-errors';
import { STUDIO_CLASS_EDIT_REFUSALS } from '@/services/studio-class-edit-refusals';

export interface StudioClassEditInitial {
  classType: string;
  location: string;
  date: string; // YYYY-MM-DD
  startTime: string;
  durationMinutes: number;
  hourlyRate: number;
}

type UpdateStudioClassWire = z.infer<typeof updateStudioClassSchema>;

interface StudioClassEditFormProps {
  studioClassId: string;
  dateEditable: boolean;
  initial: StudioClassEditInitial;
}

export function StudioClassEditForm({
  studioClassId,
  dateEditable,
  initial,
}: StudioClassEditFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');

  function set<K extends keyof StudioClassEditInitial>(key: K, value: StudioClassEditInitial[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    // A marker left over from the previous values describes values that are
    // no longer on screen — same reason StudentCountEditor clears on change.
    setSuccess('');
    setError('');
  }

  async function handleSave() {
    setSaving(true);
    setSuccess('');
    setError('');
    try {
      // The five always-writable fields go in every payload. `date` does not:
      // the API refuses its PRESENCE on a row whose `dateEditable` is false,
      // not a change to it — re-sending the unchanged date of a generated row
      // would 409. Omission is what keeps the form honest with gate 2.
      const payload: UpdateStudioClassWire = {
        classType: form.classType,
        location: form.location,
        startTime: form.startTime,
        durationMinutes: form.durationMinutes,
        hourlyRate: form.hourlyRate,
      };
      if (dateEditable) {
        payload.date = form.date;
      }
      const res = await fetch(`/api/studio-classes/${studioClassId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSuccess('Saved');
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not save. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-[480px]">
      <section className="flex flex-col gap-4">
        <Input
          label="Class type"
          value={form.classType}
          onChange={(e) => set('classType', e.target.value)}
        />
        <Input
          label="Location"
          value={form.location}
          onChange={(e) => set('location', e.target.value)}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            value={form.date}
            disabled={!dateEditable}
            onChange={(e) => set('date', e.target.value)}
          />
          <Input
            label="Start time"
            type="time"
            value={form.startTime}
            onChange={(e) => set('startTime', e.target.value)}
          />
        </div>
        {!dateEditable && (
          <p className="type-caption max-w-[420px]">
            {STUDIO_CLASS_EDIT_REFUSALS.generated_date.message}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Duration (minutes)"
            type="number"
            value={String(form.durationMinutes)}
            onChange={(e) => set('durationMinutes', Number(e.target.value))}
          />
          <Input
            label="Hourly rate (€)"
            type="number"
            step="0.01"
            value={String(form.hourlyRate)}
            onChange={(e) => set('hourlyRate', Number(e.target.value))}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
        {/* One slot, never both: "Saved" and a failure describe the same click. */}
        {error
          ? <span className="type-caption text-danger">{error}</span>
          : success && <span className="type-caption text-teal">{success}</span>}
      </div>
    </div>
  );
}
