'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { Currency } from '@prisma/client';
import type { updateTeacherSchema } from '@/lib/schemas';
import type { NotificationPrefsBody } from '@/components/settings/notification-prefs-form';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import type { TimeZoneOptions } from '@/lib/timezone-options';
import { CURRENCIES, currencyLabel } from '@/lib/format';
import { bankMethodsAvailable } from '@/lib/payment-methods';
import type { CurrencySwitchResult } from '@/services/currency-switch';

type UpdateTeacherWire = z.infer<typeof updateTeacherSchema>;

/** Every field this form edits and sends. `email` is shown, not edited, so it is a separate prop. */
export interface ProfileFormValues {
  firstName: string;
  lastName: string;
  bio: string;
  pageSlug: string;
  currency: Currency;
  defaultTimezone: string;
  bankIban: string | null;
  bankAccountName: string | null;
}

/**
 * Forward: a field added to `updateTeacherSchema` with no matching key in
 * `ProfileFormValues` fails the build, naming it — except the keys of
 * `NotificationPrefsBody`. Reverse: a key in `ProfileFormValues` the schema
 * dropped fails the build too — `.strict()` would 400 it at runtime; this
 * catches it at compile time. Both pins reach the wire body because
 * `handleSubmit` builds it as a `payload` literal typed `ProfileFormWire` —
 * the same keys, `currency` optional — and stringifies that literal directly:
 * the excess-property check on that literal guards every key of the object
 * actually sent but `currency`, which enters through a spread, where no such
 * check applies; `ProfileFormWire` types its value.
 */
const _formCoversSchema: NoneOf<Exclude<Exclude<keyof UpdateTeacherWire, keyof NotificationPrefsBody>, keyof ProfileFormValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ProfileFormValues, keyof UpdateTeacherWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;

/** The body a save sends: `currency` only when the teacher changed it. */
type ProfileFormWire = Omit<ProfileFormValues, 'currency'> & { currency?: Currency };

interface ProfileFormProps {
  teacherId: string;
  email: string;
  initial: ProfileFormValues;
  timeZoneOptions: TimeZoneOptions;
}

/** Each currency's option label; the select lists them in `CURRENCIES` order. */
const CURRENCY_OPTION_LABELS = {
  EUR: 'EUR (€)',
  GBP: 'GBP (£)',
  USD: 'USD ($)',
  CHF: 'CHF (Fr.)',
  SEK: 'SEK (kr)',
  NOK: 'NOK (kr)',
  DKK: 'DKK (kr)',
} as const satisfies Record<Currency, string>;

const CURRENCY_OPTIONS = CURRENCIES.map((currency) => [currency, CURRENCY_OPTION_LABELS[currency]] as const);

function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCY_OPTION_LABELS, value);
}

/**
 * What a currency switch did, in one line: the classes now in the new
 * currency, then, per currency, the ones that keep their own. Studio classes
 * count as classes. A clause whose count is zero is left out; empty when
 * every one is.
 */
export function currencySwitchLine(result: CurrencySwitchResult, to: Currency): string {
  const relabelled = result.relabelled.classes + result.relabelled.studioClasses;
  const sentences: string[] = [];
  if (relabelled > 0) {
    sentences.push(
      relabelled === 1
        ? `1 upcoming class now shows ${currencyLabel(to)}.`
        : `${relabelled} upcoming classes now show ${currencyLabel(to)}.`,
    );
  }
  const keptClauses: string[] = [];
  let keptTotal = 0;
  for (const group of result.kept) {
    const n = group.classes + group.studioClasses;
    if (n === 0) continue;
    keptTotal += n;
    keptClauses.push(
      n === 1 ? `1 class keeps ${currencyLabel(group.currency)}` : `${n} classes keep ${currencyLabel(group.currency)}`,
    );
  }
  if (keptTotal > 0) {
    const reason = keptTotal === 1 ? 'it’s' : 'they’re';
    sentences.push(`${keptClauses.join(', ')}, because ${reason} booked, finished or cancelled.`);
  }
  return sentences.join(' ');
}

export function ProfileForm({ teacherId, email, initial, timeZoneOptions }: ProfileFormProps) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  // The currency the server last confirmed. A save names `currency` only when
  // the select differs from it, so a save from a tab opened before a switch
  // made elsewhere leaves that switch standing.
  const [savedCurrency, setSavedCurrency] = useState(initial.currency);
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
      const sentCurrency = form.currency !== savedCurrency ? form.currency : undefined;
      const payload: ProfileFormWire = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        bio: form.bio.trim(),
        pageSlug: form.pageSlug.trim(),
        ...(sentCurrency !== undefined ? { currency: sentCurrency } : {}),
        defaultTimezone: form.defaultTimezone,
        bankIban: form.bankIban?.trim() || null,
        bankAccountName: form.bankAccountName?.trim() || null,
      };
      const res = await fetch(`/api/teachers/${teacherId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        setError(await readErrorMessage(res, 'Failed to save'));
        return;
      }

      const saved = (await res.json()) as { data?: { currencySwitch?: CurrencySwitchResult } };
      const switched = saved.data?.currencySwitch;
      if (sentCurrency !== undefined) setSavedCurrency(sentCurrency);
      setSuccess((switched && sentCurrency !== undefined && currencySwitchLine(switched, sentCurrency)) || 'Saved');
      router.refresh();
    } catch (err) {
      logRequestFailure('profile-form', { teacherId }, err);
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
          <p className="text-base text-ink py-3">{email}</p>
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
          value={form.currency}
          onChange={(e) => {
            if (isCurrency(e.target.value)) update('currency', e.target.value);
          }}
        >
          {CURRENCY_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
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
      </section>

      {/* Payment */}
      <section className="flex flex-col gap-4">
        <h2 className="type-subtitle">Payment</h2>
        <Input
          label="Bank IBAN"
          value={form.bankIban ?? ''}
          onChange={(e) => update('bankIban', e.target.value || null)}
          hint={
            bankMethodsAvailable(form.currency)
              ? undefined
              : 'Students are shown your bank details only for euro payments.'
          }
        />
        <Input
          label="Account holder name"
          value={form.bankAccountName ?? ''}
          onChange={(e) => update('bankAccountName', e.target.value || null)}
          hint="Exactly as your bank shows it — your students’ banks check this name."
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
