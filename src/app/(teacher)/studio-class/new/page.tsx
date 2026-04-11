'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';

export default function NewStudioClassPage() {
  const router = useRouter();
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
      const res = await fetch('/api/studio-classes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: location.trim(),
          date,
          startTime,
          durationMinutes: Number(durationMinutes),
          hourlyRate: Number(hourlyRate),
        }),
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
      <PageHeader title="Log studio class" backHref="/schedule" />
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Yoga Studio Centrum, Amsterdam" />
        <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Input label="Start time" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        <Input label="Duration (minutes)" type="number" value={durationMinutes} onChange={(e) => setDurationMinutes(e.target.value)} />
        <Input label="Hourly rate" type="number" step="0.01" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} />

        {error && <p className="text-sm text-error">{error}</p>}

        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating...' : 'Log class'}
        </Button>
      </form>
    </>
  );
}
