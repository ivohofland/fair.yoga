'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Currency } from '@prisma/client';
import type { z } from 'zod';
import type { bankAccountSchema } from '@/lib/schemas';
import { SCHEME_FOR_CURRENCY, type BankDetails } from '@/lib/bank-details';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { listRowClass } from '@/components/ui/list-row';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { ISSUE_SEPARATOR } from '@/lib/validation-message';

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

interface RemoveControlProps {
  currency: Currency;
  busy: boolean;
  disabled: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Remove, then an inline confirmation in the page: nothing is sent on the first tap. */
function RemoveControl({ currency, busy, disabled, confirming, onAsk, onCancel, onConfirm }: RemoveControlProps) {
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="destructive"
        aria-label={`Remove ${currency} account`}
        onClick={onAsk}
        disabled={disabled}
      >
        {busy ? 'Removing...' : 'Remove'}
      </Button>
    );
  }
  return (
    <div role="group" aria-label={`Remove ${currency} details`} className="flex flex-col gap-3">
      <p className="type-caption">
        Remove {currency} details? Students with unpaid {currency} classes will no longer see them.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <Button type="button" variant="destructive" onClick={onConfirm} disabled={disabled}>Confirm</Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={disabled}>Cancel</Button>
      </div>
    </div>
  );
}

export function BankAccountForm({ teacherId, currency, initial, hasAccount, others }: BankAccountFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<BankAccountValues>(initial);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<BankAccountField, string>>>({});
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState<'saving' | Currency | null>(null);
  const [confirming, setConfirming] = useState<Currency | null>(null);
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
    setBusy('saving');
    setError('');
    setSuccess('');
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
        const { code, message } = await readError(res, 'Couldn’t save your bank details');
        const named = fieldError(message);
        if (code === 'BIC_REQUIRED') setFieldErrors({ bic: named?.text ?? message });
        else if (named !== null && shownFields.includes(named.field)) setFieldErrors({ [named.field]: named.text });
        else setError(message);
        return;
      }
      setSuccess('Saved');
      router.refresh();
    } catch (err) {
      logRequestFailure('bank-account-form', { teacherId, currency }, err);
      setError('Network error. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(target: Currency) {
    setConfirming(null);
    setBusy(target);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`/api/teachers/${teacherId}/bank-accounts/${target}`, { method: 'DELETE' });
      if (!res.ok) {
        setError((await readError(res, 'Couldn’t remove that account')).message);
        return;
      }
      if (target === currency) {
        setForm(EMPTY_BANK_ACCOUNT);
        setFieldErrors({});
      }
      router.refresh();
    } catch (err) {
      logRequestFailure('bank-account-form', { teacherId, currency: target }, err);
      setError('Network error. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-10 pt-6 border-t border-border flex flex-col gap-4">
      <h2 className="type-subtitle">Bank details</h2>
      <p className="type-caption">Students see these when they pay for a class in {currency}.</p>
      <form onSubmit={handleSave} className="flex flex-col gap-4">
        {fields.map(({ key, label }) => (
          <Input
            key={key}
            id={`bank-${key}`}
            label={label}
            value={form[key]}
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
          error={fieldErrors.holderName}
          onChange={(e) => update('holderName', e.target.value)}
        />
        {error && <p role="alert" className="type-caption text-danger">{error}</p>}
        {success && <p className="type-caption text-teal">{success}</p>}
        <Button type="submit" variant="secondary" disabled={busy !== null}>
          {busy === 'saving' ? 'Saving...' : 'Save bank details'}
        </Button>
      </form>

      {hasAccount && (
        <RemoveControl
          currency={currency}
          busy={busy === currency}
          disabled={busy !== null}
          confirming={confirming === currency}
          onAsk={() => setConfirming(currency)}
          onCancel={() => setConfirming(null)}
          onConfirm={() => handleRemove(currency)}
        />
      )}

      {others.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="type-label">Accounts in other currencies</h3>
          <ul className="flex flex-col">
            {others.map((other) => (
              <li key={other.currency} className={listRowClass({ className: 'flex items-center justify-between gap-4' })}>
                <span className="type-body">
                  {other.currency} <span className="type-number">{other.masked}</span>
                </span>
                <RemoveControl
                  currency={other.currency}
                  busy={busy === other.currency}
                  disabled={busy !== null}
                  confirming={confirming === other.currency}
                  onAsk={() => setConfirming(other.currency)}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => handleRemove(other.currency)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
