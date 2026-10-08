'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Currency } from '@prisma/client';
import type { z } from 'zod';
import type { bankAccountSchema } from '@/lib/schemas';
import { SCHEME_FOR_CURRENCY, type BankDetails } from '@/lib/bank-details';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { listRowClass } from '@/components/ui/list-row';
import { RemoveControl } from './remove-control';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { ISSUE_SEPARATOR } from '@/lib/validation-message';
import { BANK_FIELD_MAX, HOLDER_NAME_MAX } from '@/lib/input-bounds';

type BankAccountWire = z.infer<typeof bankAccountSchema>;
type BankAccountField = keyof BankAccountWire;

/** What the block edits, every field a string, `''` when unset. */
export type BankAccountValues = Record<BankAccountField, string>;

export const EMPTY_BANK_ACCOUNT = {
  holderName: '', iban: '', bic: '', sortCode: '', accountNumber: '', routingNumber: '',
} as const satisfies BankAccountValues;

/** Each scheme's fields, in the order the block shows them, above the holder name. */
const SCHEME_FIELDS = {
  sepa: [
    { key: 'iban', label: 'IBAN' },
    { key: 'bic', label: 'BIC (needed for an IBAN outside the EEA)' },
  ],
  iban: [
    { key: 'iban', label: 'IBAN' },
    { key: 'bic', label: 'BIC (optional)' },
  ],
  uk: [
    { key: 'sortCode', label: 'Sort code' },
    { key: 'accountNumber', label: 'Account number' },
  ],
  us: [
    { key: 'routingNumber', label: 'Routing number' },
    { key: 'accountNumber', label: 'Account number' },
  ],
} as const satisfies Record<BankDetails['scheme'], readonly { key: Exclude<BankAccountField, 'holderName'>; label: string }[]>;

function isField(key: string): key is BankAccountField {
  return Object.hasOwn(EMPTY_BANK_ACCOUNT, key);
}

/**
 * The field a 400 names and the text to show on it, read from `formatIssues`'
 * `path: message` shape; `null` when it names none of this block's fields.
 */
function fieldError(message: string): { field: BankAccountField; text: string } | null {
  const first = message.split(ISSUE_SEPARATOR)[0] ?? '';
  const colon = first.indexOf(': ');
  if (colon < 0) return null;
  const field = first.slice(0, colon);
  return isField(field) ? { field, text: first.slice(colon + 2) } : null;
}

/**
 * The stored account a successful save answers with, as the block's values;
 * `null` when the body does not hold one.
 */
function storedValues(json: unknown): BankAccountValues | null {
  if (typeof json !== 'object' || json === null || !('data' in json)) return null;
  const { data } = json;
  if (typeof data !== 'object' || data === null) return null;
  const values: BankAccountValues = { ...EMPTY_BANK_ACCOUNT };
  for (const key of Object.keys(EMPTY_BANK_ACCOUNT)) {
    if (!isField(key)) continue;
    const value: unknown = Object.hasOwn(data, key) ? (data as Record<string, unknown>)[key] : undefined;
    if (value === null) continue;
    if (typeof value !== 'string') return null;
    values[key] = value;
  }
  return values;
}

interface BankAccountFormProps {
  teacherId: string;
  /** The teacher's current currency: the account this block edits. */
  currency: Currency;
  initial: BankAccountValues;
  /** Whether the current currency already has a stored account to remove. */
  hasAccount: boolean;
  /** Accounts the teacher holds in other currencies, identifier masked. */
  others: readonly { currency: Currency; masked: string }[];
}

export function BankAccountForm({ teacherId, currency, initial, hasAccount, others }: BankAccountFormProps) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [form, setForm] = useState<BankAccountValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<BankAccountField, string>>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<Currency | null>(null);
  const [removing, setRemoving] = useState<Currency | null>(null);
  const [removeError, setRemoveError] = useState<{ currency: Currency; message: string } | null>(null);
  const [removed, setRemoved] = useState('');
  const busy = saving || removing !== null;
  const fields = SCHEME_FIELDS[SCHEME_FOR_CURRENCY[currency]];
  const shownFields: readonly BankAccountField[] = [...fields.map((f) => f.key), 'holderName'];

  function update(key: BankAccountField, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    setError('');
    setSuccess('');
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    setRemoved('');
    setFieldErrors({});
    try {
      const payload: BankAccountWire = { holderName: form.holderName.trim() };
      for (const { key } of fields) {
        const value = form[key].trim();
        if (value !== '') payload[key] = value;
      }
      const res = await fetch(`/api/teachers/${teacherId}/bank-accounts/${currency}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const { code, message } = await readError(res, 'Couldn’t save your bank details.');
        const named = fieldError(message);
        if (code === 'BIC_REQUIRED') setFieldErrors({ bic: named?.text ?? message });
        else if (named !== null && shownFields.includes(named.field)) setFieldErrors({ [named.field]: named.text });
        else setError(named?.text ?? message);
        return;
      }
      // The stored values are normalised (spacing, case, separators): show
      // those. The save has committed, so an unreadable body keeps the typed
      // values rather than reporting a failure.
      let body: unknown = null;
      try {
        body = await res.json();
      } catch (err) {
        logRequestFailure('bank-account-form', { teacherId, currency }, err);
      }
      const stored = storedValues(body);
      if (stored !== null) setForm(stored);
      setSuccess('Saved');
      router.refresh();
    } catch (err) {
      logRequestFailure('bank-account-form', { teacherId, currency }, err);
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function ask(target: Currency) {
    setConfirming(target);
    setRemoveError(null);
    setRemoved('');
  }

  async function handleRemove(target: Currency) {
    setRemoving(target);
    setRemoveError(null);
    setRemoved('');
    setSuccess('');
    let done = false;
    try {
      const res = await fetch(`/api/teachers/${teacherId}/bank-accounts/${target}`, { method: 'DELETE' });
      if (res.ok) {
        done = true;
      } else {
        const { message } = await readError(res, `Couldn’t remove the ${target} details.`);
        setRemoveError({ currency: target, message });
      }
    } catch (err) {
      logRequestFailure('bank-account-form', { teacherId, currency: target }, err);
      setRemoveError({ currency: target, message: 'Network error. Please try again.' });
    } finally {
      setRemoving(null);
    }
    if (!done) return;

    setConfirming(null);
    if (target === currency) {
      setForm(EMPTY_BANK_ACCOUNT);
      setFieldErrors({});
      setError('');
    }
    setRemoved(`${target} details removed.`);
    // The control that had focus is gone; the section's heading is where the
    // outcome line sits.
    headingRef.current?.focus();
    router.refresh();
  }

  function removeControlProps(target: Currency) {
    return {
      label: `${target} details`,
      question: `Remove ${target} details? Students with unpaid ${target} classes will no longer see them.`,
      confirming: confirming === target,
      removing: removing === target,
      disabled: busy,
      error: removeError?.currency === target ? removeError.message : '',
      onAsk: () => ask(target),
      onCancel: () => setConfirming(null),
      onConfirm: () => void handleRemove(target),
    };
  }

  return (
    <section className="mt-10 pt-6 border-t border-border flex flex-col gap-4">
      <h2 ref={headingRef} tabIndex={-1} className="type-subtitle focus:outline-none">Bank details</h2>
      <p className="type-caption">Students see these when they pay for a class in {currency}.</p>
      {removed && <p role="status" className="type-caption text-teal">{removed}</p>}
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        {fields.map(({ key, label }) => (
          <Input
            key={key}
            id={`bank-${key}`}
            label={label}
            value={form[key]}
            maxLength={BANK_FIELD_MAX}
            error={fieldErrors[key]}
            autoComplete="off"
            onChange={(e) => update(key, e.target.value)}
          />
        ))}
        <Input
          id="bank-holderName"
          label="Account holder name"
          hint="Exactly as your bank shows it — your students’ banks check this name."
          value={form.holderName}
          maxLength={HOLDER_NAME_MAX}
          error={fieldErrors.holderName}
          onChange={(e) => update('holderName', e.target.value)}
        />
        {error && <p role="alert" className="type-caption text-danger">{error}</p>}
        {success && <p className="type-caption text-teal">{success}</p>}
        <Button type="submit" variant="secondary" disabled={busy}>
          {saving ? 'Saving...' : 'Save bank details'}
        </Button>
      </form>

      {hasAccount && <RemoveControl {...removeControlProps(currency)} />}

      {others.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="type-label">Accounts in other currencies</h3>
          <ul className="flex flex-col">
            {others.map((other) => (
              <li key={other.currency} className={listRowClass({ className: 'flex flex-col justify-center' })}>
                <RemoveControl {...removeControlProps(other.currency)}>
                  <span className="type-body">
                    {other.currency} <span className="type-number">{other.masked}</span>
                  </span>
                </RemoveControl>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
