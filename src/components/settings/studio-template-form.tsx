'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createStudioClassTemplateSchema, updateStudioClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { SettledNotice } from '@/components/ui/settled-notice';

/**
 * #136. The one enumeration of this form's fields. It replaced three that
 * nothing reconciled: this prop's inline type, `INITIAL_VALUES`, and the
 * request body. The pins below hold it against both wire schemas.
 */
export interface StudioTemplateFormValues {
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  location: string;
  hourlyRate: number;
}

type CreateStudioTemplateWire = z.infer<typeof createStudioClassTemplateSchema>;
type UpdateStudioTemplateWire = z.infer<typeof updateStudioClassTemplateSchema>;

/**
 * #136. Four pins, because one body serves both endpoints — the shape
 * `template-form.tsx` established. The two schemas agree on keys today; the
 * day they diverge, a pin against only one would not notice.
 */
const _formCoversCreate: NoneOf<Exclude<keyof CreateStudioTemplateWire, keyof StudioTemplateFormValues>> = true;
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateStudioTemplateWire, keyof StudioTemplateFormValues>> = true;
const _formHasNoExtrasOnCreate: NoneOf<Exclude<keyof StudioTemplateFormValues, keyof CreateStudioTemplateWire>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof StudioTemplateFormValues, keyof UpdateStudioTemplateWire>> = true;
void _formCoversCreate;
void _formCoversUpdate;
void _formHasNoExtrasOnCreate;
void _formHasNoExtras;

interface StudioTemplateFormProps {
  mode: 'create' | 'edit';
  templateId?: string;
  initial?: StudioTemplateFormValues;
}

const DAY_OPTIONS = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
];

/**
 * #40 (whole-branch review F8). Written once, for the same reason as
 * `template-form.tsx`'s twin: the create push and the settled notice's retry
 * are one navigation, and a second literal is how they drift apart.
 */
const STUDIO_CLASSES_PATH = '/settings/studio-classes';

const INITIAL_VALUES: StudioTemplateFormValues = {
  classType: '',
  dayOfWeek: 0,
  startTime: '09:00',
  durationMinutes: 60,
  location: '',
  hourlyRate: 0,
};

export function StudioTemplateForm({ mode, templateId, initial }: StudioTemplateFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial ?? INITIAL_VALUES);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSuccess('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // #40. A settled create must not be re-submittable, including via Enter in
    // a still-mounted field.
    if (created) return;
    if (!form.location.trim()) {
      setError('Location is required');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const url = mode === 'create'
        ? '/api/studio-class-templates'
        : `/api/studio-class-templates/${templateId}`;
      const method = mode === 'create' ? 'POST' : 'PUT';

      // The intersection, not either half: one body goes to both endpoints, so
      // it has to satisfy both schemas. See template-form.tsx's identical
      // payload annotation for why this matters beyond the key-set pins above.
      const payload: CreateStudioTemplateWire & UpdateStudioTemplateWire = {
        ...form,
        classType: form.classType.trim(),
        location: form.location.trim(),
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to save');
        return;
      }

      if (mode === 'create') {
        // #40. POST /api/studio-class-templates is not idempotent: a second
        // request creates a second template and a second generated window.
        setCreated(true);
        router.push(STUDIO_CLASSES_PATH);
      } else {
        setSuccess('Saved');
        router.refresh();
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Input
        label="Class type"
        value={form.classType}
        onChange={(e) => update('classType', e.target.value)}
        placeholder="e.g. Vinyasa, Hatha, Yin"
      />

      <Input
        label="Location"
        value={form.location}
        onChange={(e) => update('location', e.target.value)}
        placeholder="e.g. Yoga Studio Centrum, Amsterdam"
      />

      <Select
        id="dayOfWeek"
        label="Day"
        value={form.dayOfWeek}
        onChange={(e) => update('dayOfWeek', Number(e.target.value))}
      >
        {DAY_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </Select>

      <Input
        label="Start time"
        type="time"
        value={form.startTime}
        onChange={(e) => update('startTime', e.target.value)}
      />

      <Input
        label="Duration (minutes)"
        type="number"
        value={String(form.durationMinutes)}
        onChange={(e) => update('durationMinutes', Number(e.target.value))}
      />

      <Input
        label="Hourly rate"
        type="number"
        step="0.01"
        value={String(form.hourlyRate)}
        onChange={(e) => update('hourlyRate', Number(e.target.value))}
      />

      {error && <p className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      {created ? (
        <SettledNotice
          label="Created"
          actionLabel="Go to studio classes"
          size="sm"
          onAction={() => router.push(STUDIO_CLASSES_PATH)}
        />
      ) : (
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      )}
    </form>
  );
}
