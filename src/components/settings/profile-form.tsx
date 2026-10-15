'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { z } from 'zod';
import type { Currency } from '@prisma/client';
import { pageSlugField, type updateTeacherSchema } from '@/lib/schemas';
import type { NotificationPrefsBody } from '@/components/settings/notification-prefs-form';
import { NAME_MAX } from '@/lib/input-bounds';
import type { NoneOf } from '@/lib/type-pins';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { PageAddressField, type SlugRejection } from '@/components/signup/page-address-field';
import { logRequestFailure, readError } from '@/lib/client-errors';
import type { TimeZoneOptions } from '@/lib/timezone-options';
import { currencyLabel } from '@/lib/format';
import { CURRENCY_INFO, suggestedCurrency } from '@/lib/currency';
import { vatPercentViolation } from '@/lib/vat';
import type { CurrencySwitchResult } from '@/services/currency-switch';

type UpdateTeacherWire = z.infer<typeof updateTeacherSchema>;

/** Every field this form edits and sends. `email` is shown, not edited, so it is a separate prop. */
export interface ProfileFormValues {
  firstName: string;
  lastName: string;
  bio: string;
  pageSlug: string;
  currency: Currency;
  defaultVatPercent: number;
  defaultTimezone: string;
}

/**
 * Forward: a field added to `updateTeacherSchema` with no matching key in
 * `ProfileFormValues` fails the build, naming it — except the keys of
 * `NotificationPrefsBody`. Reverse: a key in `ProfileFormValues` the schema
 * dropped fails the build too — `.strict()` would 400 it at runtime; this
 * catches it at compile time. Both pins reach the wire body because
 * `handleSubmit` builds it as a `payload` literal typed `ProfileFormWire` —
 * the same keys, `currency` and `pageSlug` optional — and stringifies that
 * literal directly: the excess-property check on that literal guards every key
 * of the object actually sent but the optional ones, which enter through
 * spreads, where no such check applies; `ProfileFormWire` types their values.
 */
const _formCoversSchema: NoneOf<Exclude<Exclude<keyof UpdateTeacherWire, keyof NotificationPrefsBody>, keyof ProfileFormValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ProfileFormValues, keyof UpdateTeacherWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;

/** The body a save sends: `currency` and `pageSlug` only when the teacher changed them. */
type ProfileFormWire = Omit<ProfileFormValues, 'currency' | 'pageSlug'> & { currency?: Currency; pageSlug?: string };

/**
 * The form-level line for a save the page address stopped. The field says
 * why; this sits by the Save button, and still shows when the field has since
 * moved off the address the save was refused for.
 */
const SLUG_NOT_SAVED = 'Not saved — check the page address.';

interface ProfileFormProps {
  teacherId: string;
  email: string;
  initial: ProfileFormValues;
  timeZoneOptions: TimeZoneOptions;
}

/** Every currency as the picker lists it, `Name (prefix)`, sorted by name. */
const CURRENCY_OPTIONS = (Object.keys(CURRENCY_INFO) as Currency[])
  .map((currency) => [currency, `${CURRENCY_INFO[currency].name} (${currencyLabel(currency)})`] as const)
  .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));

function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCY_INFO, value);
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
  const suggested = suggestedCurrency(form.defaultTimezone);
  const suggestion = suggested !== null && suggested !== form.currency ? suggested : null;
  const suggestionLabel = CURRENCY_OPTIONS.find(([c]) => c === suggestion)?.[1] ?? '';
  // The currency the server last confirmed. A save names `currency` only when
  // the select differs from it, so a save from a tab opened before a switch
  // made elsewhere leaves that switch standing.
  const [savedCurrency, setSavedCurrency] = useState(initial.currency);
  // The slug the server last confirmed. The warning below names it while the
  // field differs, and a save names `pageSlug` only then, so a save from a tab
  // opened before a slug change made elsewhere does not move the page back. It
  // is also the field's `currentSlug`, except while a save is in flight (below).
  const [savedSlug, setSavedSlug] = useState(initial.pageSlug);
  // The slug a save in flight is sending, passed as the field's `currentSlug`
  // until the save answers: the server may already hold it for this teacher,
  // and a check of it now would report their own address taken.
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const slugWarningId = useId();
  // A 409 `SLUG_TAKEN` from a save, shown on the field only while it still
  // holds the slug refused: an edit retires it without a clear.
  const [slugRejection, setSlugRejection] = useState<SlugRejection | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const slugChanged = form.pageSlug.trim() !== savedSlug;
  const slugError =
    slugRejection !== null && slugRejection.slug === form.pageSlug.trim() ? slugRejection.message : undefined;

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
      setError('Page address is required');
      return;
    }
    // A changed slug `pageSlugField` refuses is not sent: the field gives the reason.
    if (slugChanged && !pageSlugField.safeParse(form.pageSlug.trim()).success) {
      setError(SLUG_NOT_SAVED);
      return;
    }
    const vatMessage = vatPercentViolation(form.defaultVatPercent);
    if (vatMessage) {
      setError(vatMessage);
      return;
    }

    setSubmitting(true);
    setError('');
    setSlugRejection(null);
    setSuccess('');

    try {
      const sentCurrency = form.currency !== savedCurrency ? form.currency : undefined;
      const sentSlug = slugChanged ? form.pageSlug.trim() : undefined;
      if (sentSlug !== undefined) setPendingSlug(sentSlug);
      const payload: ProfileFormWire = {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        bio: form.bio.trim(),
        ...(sentSlug !== undefined ? { pageSlug: sentSlug } : {}),
        ...(sentCurrency !== undefined ? { currency: sentCurrency } : {}),
        defaultVatPercent: form.defaultVatPercent,
        defaultTimezone: form.defaultTimezone,
      };
      const res = await fetch(`/api/teachers/${teacherId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const { code, message } = await readError(res, 'Failed to save');
        if (code === 'SLUG_TAKEN' && sentSlug !== undefined) {
          setSlugRejection({ slug: sentSlug, message });
          setError(SLUG_NOT_SAVED);
        } else {
          setError(message);
        }
        return;
      }

      const saved = (await res.json()) as { data?: { currencySwitch?: CurrencySwitchResult } };
      const switched = saved.data?.currencySwitch;
      if (sentCurrency !== undefined) setSavedCurrency(sentCurrency);
      if (sentSlug !== undefined) setSavedSlug(sentSlug);
      setSuccess((switched && sentCurrency !== undefined && currencySwitchLine(switched, sentCurrency)) || 'Saved');
      router.refresh();
    } catch (err) {
      logRequestFailure('profile-form', { teacherId }, err);
      setError('Network error. Please try again.');
    } finally {
      setPendingSlug(null);
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
          maxLength={NAME_MAX}
          onChange={(e) => update('firstName', e.target.value)}
        />
        <Input
          label="Last name"
          value={form.lastName}
          maxLength={NAME_MAX}
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
        <PageAddressField
          value={form.pageSlug}
          onChange={(value) => update('pageSlug', value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          currentSlug={pendingSlug ?? savedSlug}
          error={slugError}
          aria-describedby={slugChanged ? slugWarningId : undefined}
        >
          {/* Always mounted, so the caption is announced as it appears while the field
              has focus — and sr-only, not hidden, while empty: a display:none region
              leaves the accessibility tree, and the caption must arrive into one
              already there. No jsdom test can see the difference. */}
          <div aria-live="polite" className="empty:sr-only">
            {slugChanged && (
              <p id={slugWarningId} className="type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3">
                Links you’ve already shared to fair.yoga/{savedSlug} will stop working.
              </p>
            )}
          </div>
        </PageAddressField>
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
          {suggestion !== null && (
            <optgroup label="Suggested">
              <option value={suggestion}>{suggestionLabel}</option>
            </optgroup>
          )}
          <optgroup label="All currencies">
            {CURRENCY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </optgroup>
        </Select>
        <NumberInput
          id="defaultVatPercent"
          label="Default VAT %"
          decimals={Infinity}
          value={form.defaultVatPercent}
          onValueChange={(n) => update('defaultVatPercent', n)}
          hint="It's your responsibility to set the right VAT rate. You can change it on each class. This is only the default for new classes. Use 0 if you don't charge VAT."
        />
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

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {success && <p className="text-sm text-teal">{success}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Saving...' : 'Save'}
      </Button>
    </form>
  );
}
