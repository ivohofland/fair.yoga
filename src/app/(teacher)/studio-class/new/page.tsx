'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { createStudioClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';

/**
 * #136. The one enumeration of this form's fields — what actually reaches
 * the request body, post-transform, below.
 */
interface StudioClassFormValues {
  classType: string;
  location: string;
  date: string;
  startTime: string;
  durationMinutes: number;
  hourlyRate: number;
}

type CreateStudioClassWire = z.infer<typeof createStudioClassSchema>;

/**
 * #136. Two keys are excluded from the forward pin. Neither belongs in this
 * form, but not because the route ignores them — it does not.
 *
 * - `studentCount` — a studio class's attendance is not known when it is
 *   created; `student-count-editor.tsx` sets it afterwards.
 * - `templateId` — server-set when a studio template materialises a class,
 *   and absent from this UI entirely.
 *
 * `POST /api/studio-classes` destructures `{ date, ...rest }` and spreads
 * `rest` straight into `prisma.studioClass.create`, so both keys reach the
 * database if a caller sends them — with no ownership check on `templateId`.
 * That is #148, the sibling of #146. Excluded here so this pin does not
 * certify either as a field this form ought to send, and so the exclusion
 * points at the tracked issue rather than at a claim that the route is safe.
 */
const _formCoversCreate: NoneOf<
  Exclude<Exclude<keyof CreateStudioClassWire, 'studentCount' | 'templateId'>, keyof StudioClassFormValues>
> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof StudioClassFormValues, keyof CreateStudioClassWire>> = true;
void _formCoversCreate;
void _formHasNoExtras;

export default function NewStudioClassPage() {
  const router = useRouter();
  const [classType, setClassType] = useState('');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [durationMinutes, setDurationMinutes] = useState('60');
  const [hourlyRate, setHourlyRate] = useState('0');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!location.trim()) {
      setError('Location is required');
      return;
    }
    if (!date) {
      setError('Date is required');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const values: StudioClassFormValues = {
        classType: classType.trim(),
        location: location.trim(),
        date,
        startTime,
        durationMinutes: Number(durationMinutes),
        hourlyRate: Number(hourlyRate),
      };

      const res = await fetch('/api/studio-classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });

      if (!res.ok) {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to create studio class');
        return;
      }

      const json: { data: { id: string } } = await res.json();
      router.push(`/studio-class/${json.data.id}`);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="Log studio class" backHref="/" backLabel="Schedule" />
      <p className="type-caption -mt-4 mb-6">
        Teach at this studio every week?{' '}
        <Link href="/settings/studio-classes/new" className="text-teal no-underline">
          Set up a recurring studio class
        </Link>{' '}
        and it logs itself.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <Input label="Class type" value={classType} onChange={(e) => setClassType(e.target.value)} placeholder="e.g. Vinyasa, Hatha, Yin" />
        <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Yoga Studio Centrum, Amsterdam" />
        <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Input label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        <Input label="Duration (minutes)" type="number" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} />
        <Input label="Hourly rate" type="number" step="0.01" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} />

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating...' : 'Log class'}
        </Button>
      </form>
    </>
  );
}
