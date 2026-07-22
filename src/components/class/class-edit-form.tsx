'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PricingPreviewTable } from '@/components/class/pricing-preview-table';

export interface ClassEditInitial {
  classType: string;
  description: string;
  date: string; // YYYY-MM-DD
  startTime: string;
  durationMinutes: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
}

interface ClassEditFormProps {
  classId: string;
  settingsLocked: boolean;
  initial: ClassEditInitial;
}

// Mirrors updateClassSchema exactly: details always editable, the five
// economic fields only while unlocked. Policies aren't part of the
// update schema, so they aren't part of this form.
export function ClassEditForm({ classId, settingsLocked, initial }: ClassEditFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  function set<K extends keyof ClassEditInitial>(key: K, value: ClassEditInitial[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        classType: form.classType,
        description: form.description || null,
        date: form.date,
        startTime: form.startTime,
        durationMinutes: form.durationMinutes,
      };
      if (!settingsLocked) {
        payload.roomCost = form.roomCost;
        payload.minRate = form.minRate;
        payload.targetRate = form.targetRate;
        payload.minStudents = form.minStudents;
        payload.maxStudents = form.maxStudents;
      }
      const res = await fetch(`/api/classes/${classId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        const json = (await res.json()) as { error?: { message?: string } | string };
        const message = typeof json.error === 'string' ? json.error : json.error?.message;
        setError(message ?? 'Could not save the class. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
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
        <Textarea
          label="Description"
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Date"
            type="date"
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
          />
          <Input
            label="Start time"
            type="time"
            value={form.startTime}
            onChange={(e) => set('startTime', e.target.value)}
          />
        </div>
        <div className="max-w-[200px]">
          <Input
            label="Duration (minutes)"
            type="number"
            value={String(form.durationMinutes)}
            onChange={(e) => set('durationMinutes', Number(e.target.value))}
          />
        </div>
      </section>

      <section>
        <h2 className="type-subtitle mb-1">Economics</h2>
        {settingsLocked && (
          <p className="type-caption mb-3 max-w-[420px]">
            Locked since the first registration — the economics can&apos;t
            change under students.
          </p>
        )}
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Room cost (€)"
            type="number"
            value={String(form.roomCost)}
            disabled={settingsLocked}
            onChange={(e) => set('roomCost', Number(e.target.value))}
          />
          <Input
            label="Min rate (€)"
            type="number"
            value={String(form.minRate)}
            disabled={settingsLocked}
            onChange={(e) => set('minRate', Number(e.target.value))}
          />
          <Input
            label="Target rate (€)"
            type="number"
            value={String(form.targetRate)}
            disabled={settingsLocked}
            onChange={(e) => set('targetRate', Number(e.target.value))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3 max-w-[320px]">
          <Input
            label="Min students"
            type="number"
            value={String(form.minStudents)}
            disabled={settingsLocked}
            onChange={(e) => set('minStudents', Number(e.target.value))}
          />
          <Input
            label="Max students"
            type="number"
            value={String(form.maxStudents)}
            disabled={settingsLocked}
            onChange={(e) => set('maxStudents', Number(e.target.value))}
          />
        </div>
        <div className="mt-4">
          <PricingPreviewTable
            roomCost={form.roomCost}
            minRate={form.minRate}
            targetRate={form.targetRate}
            minStudents={form.minStudents}
            maxStudents={form.maxStudents}
          />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save changes'}
        </Button>
        {saved && <span className="type-caption text-teal">Saved</span>}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
