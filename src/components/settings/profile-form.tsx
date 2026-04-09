'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ProfileFormProps {
  teacherId: string;
  initial: {
    firstName: string;
    lastName: string;
    email: string;
    bio: string;
    pageSlug: string;
    defaultCurrency: string;
    defaultTimezone: string;
    defaultReminder: string;
    bankIban: string | null;
    bankAccountName: string | null;
  };
}

const CURRENCY_OPTIONS = [
  { value: 'EUR', label: 'EUR (€)' },
  { value: 'GBP', label: 'GBP (£)' },
  { value: 'USD', label: 'USD ($)' },
  { value: 'CHF', label: 'CHF (Fr.)' },
  { value: 'SEK', label: 'SEK (kr)' },
  { value: 'NOK', label: 'NOK (kr)' },
  { value: 'DKK', label: 'DKK (kr)' },
  { value: 'PLN', label: 'PLN (zł)' },
  { value: 'CZK', label: 'CZK (Kč)' },
  { value: 'CAD', label: 'CAD ($)' },
  { value: 'AUD', label: 'AUD ($)' },
];

const TIMEZONE_OPTIONS = [
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Amsterdam', label: 'Amsterdam (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Brussels', label: 'Brussels (CET)' },
  { value: 'Europe/Zurich', label: 'Zurich (CET)' },
  { value: 'Europe/Vienna', label: 'Vienna (CET)' },
  { value: 'Europe/Stockholm', label: 'Stockholm (CET)' },
  { value: 'Europe/Copenhagen', label: 'Copenhagen (CET)' },
  { value: 'Europe/Oslo', label: 'Oslo (CET)' },
  { value: 'Europe/Madrid', label: 'Madrid (CET)' },
  { value: 'Europe/Rome', label: 'Rome (CET)' },
  { value: 'Europe/Lisbon', label: 'Lisbon (WET)' },
  { value: 'Europe/Warsaw', label: 'Warsaw (CET)' },
  { value: 'Europe/Prague', label: 'Prague (CET)' },
  { value: 'Europe/Helsinki', label: 'Helsinki (EET)' },
  { value: 'Europe/Athens', label: 'Athens (EET)' },
  { value: 'America/New_York', label: 'New York (EST)' },
  { value: 'America/Chicago', label: 'Chicago (CST)' },
  { value: 'America/Denver', label: 'Denver (MST)' },
  { value: 'America/Los_Angeles', label: 'Los Angeles (PST)' },
  { value: 'America/Toronto', label: 'Toronto (EST)' },
  { value: 'America/Vancouver', label: 'Vancouver (PST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  { value: 'Australia/Melbourne', label: 'Melbourne (AEST)' },
];

const REMINDER_OPTIONS = [
  { value: 'morning_of', label: 'Morning of class' },
  { value: 'evening_before', label: 'Evening before' },
  { value: 'one_hour_before', label: '1 hour before' },
];

const selectClass =
  'bg-cream border border-teal rounded-none px-4 pr-10 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full appearance-none bg-[length:16px_16px] bg-[position:right_12px_center] bg-no-repeat bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27%236B5B4E%27%20stroke-width%3D%272%27%3E%3Cpath%20d%3D%27M6%209l6%206%206-6%27/%3E%3C/svg%3E")]';

export function ProfileForm({ teacherId, initial }: ProfileFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSuccess('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName.trim()) {
      setError('First name is required');
      return;
    }
    if (!form.bio.trim()) {
      setError('Bio is required');
      return;
    }
    if (!form.pageSlug.trim()) {
      setError('Page slug is required');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`/api/teachers/${teacherId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          bio: form.bio.trim(),
          pageSlug: form.pageSlug.trim(),
          defaultCurrency: form.defaultCurrency,
          defaultTimezone: form.defaultTimezone,
          defaultReminder: form.defaultReminder,
          bankIban: form.bankIban?.trim() || null,
          bankAccountName: form.bankAccountName?.trim() || null,
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {/* Personal */}
      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-lg font-bold text-teal">Personal</h2>
        <Input
          label="First name"
          value={form.firstName}
          onChange={(e) => update('firstName', e.target.value)}
        />
        <Input
          label="Last name"
          value={form.lastName}
          onChange={(e) => update('lastName', e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <span className="text-brown">Email</span>
          <p className="text-dark text-sm py-3">{initial.email}</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bio" className="text-brown">Bio (max 250 characters)</label>
          <textarea
            id="bio"
            value={form.bio}
            onChange={(e) => update('bio', e.target.value)}
            maxLength={250}
            rows={3}
            className="bg-cream border border-teal rounded-none px-4 py-3 min-h-[44px] text-dark focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--color-teal)] w-full"
          />
          <span className="text-xs text-brown opacity-60">{form.bio.length}/250</span>
        </div>
      </section>

      {/* Public page */}
      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-lg font-bold text-teal">Public page</h2>
        <Input
          label="Page slug"
          value={form.pageSlug}
          onChange={(e) => update('pageSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
        <p className="text-xs text-brown opacity-60">
          Your booking page: fair.yoga/{form.pageSlug}
        </p>
      </section>

      {/* Preferences */}
      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-lg font-bold text-teal">Preferences</h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="currency" className="text-brown">Currency</label>
          <select
            id="currency"
            value={form.defaultCurrency}
            onChange={(e) => update('defaultCurrency', e.target.value)}
            className={selectClass}
          >
            {CURRENCY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="timezone" className="text-brown">Timezone</label>
          <select
            id="timezone"
            value={form.defaultTimezone}
            onChange={(e) => update('defaultTimezone', e.target.value)}
            className={selectClass}
          >
            {TIMEZONE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="reminder" className="text-brown">Default reminder</label>
          <select
            id="reminder"
            value={form.defaultReminder}
            onChange={(e) => update('defaultReminder', e.target.value)}
            className={selectClass}
          >
            {REMINDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      </section>

      {/* Payment */}
      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-lg font-bold text-teal">Payment</h2>
        <Input
          label="Bank IBAN"
          value={form.bankIban ?? ''}
          onChange={(e) => update('bankIban', e.target.value || null)}
        />
        <Input
          label="Account holder name"
          value={form.bankAccountName ?? ''}
          onChange={(e) => update('bankAccountName', e.target.value || null)}
        />
      </section>

      {error && <p className="text-sm text-error">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
