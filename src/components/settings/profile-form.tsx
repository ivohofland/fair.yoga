'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';
import type { TimeZoneOptions } from '@/lib/timezone-options';

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
  timeZoneOptions: TimeZoneOptions;
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

const REMINDER_OPTIONS = [
  { value: 'morning_of', label: 'Morning of class' },
  { value: 'evening_before', label: 'Evening before' },
  { value: 'one_hour_before', label: '1 hour before' },
];

export function ProfileForm({ teacherId, initial, timeZoneOptions }: ProfileFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError('');
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
        setError(await readErrorMessage(res, 'Failed to save'));
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
        <h2 className="type-subtitle">Personal</h2>
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
          <p className="text-base text-ink py-3">{initial.email}</p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="bio" className="text-brown">Bio (max 250 characters)</label>
          <textarea
            id="bio"
            value={form.bio}
            onChange={(e) => update('bio', e.target.value)}
            maxLength={250}
            rows={3}
            className="bg-sand-soft border border-border rounded-field px-4 py-3 min-h-24 text-ink text-base focus:outline-none focus:shadow-focus w-full"
          />
          <span className="type-caption">{form.bio.length}/250</span>
        </div>
      </section>

      {/* Public page */}
      <section className="flex flex-col gap-4">
        <h2 className="type-subtitle">Public page</h2>
        <Input
          label="Page slug"
          value={form.pageSlug}
          onChange={(e) => update('pageSlug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
        <p className="type-caption">
          Your booking page: fair.yoga/{form.pageSlug}
        </p>
      </section>

      {/* Preferences */}
      <section className="flex flex-col gap-4">
        <h2 className="type-subtitle">Preferences</h2>
        <Select
          id="currency"
          label="Currency"
          value={form.defaultCurrency}
          onChange={(e) => update('defaultCurrency', e.target.value)}
        >
          {CURRENCY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
        <Select
          id="timezone"
          label="Timezone"
          value={form.defaultTimezone}
          onChange={(e) => update('defaultTimezone', e.target.value)}
        >
          {timeZoneOptions.standalone.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
          {timeZoneOptions.groups.map((group) => (
            <optgroup key={group.region} label={group.region}>
              {group.options.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select
          id="reminder"
          label="Default reminder"
          value={form.defaultReminder}
          onChange={(e) => update('defaultReminder', e.target.value)}
        >
          {REMINDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </Select>
      </section>

      {/* Payment */}
      <section className="flex flex-col gap-4">
        <h2 className="type-subtitle">Payment</h2>
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

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
