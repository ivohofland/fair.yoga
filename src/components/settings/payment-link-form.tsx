'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { RemoveControl } from './remove-control';
import { PAYMENT_LINK_MESSAGES, parsePaymentLink } from '@/lib/payment-link';

interface PaymentLinkFormProps {
  teacherId: string;
  /** The stored link, `''` when none. */
  initial: string;
  /** Whether a link is stored to remove. */
  hasLink: boolean;
}

const FIELD_PREFIX = 'paymentLink: ';

export function PaymentLinkForm({ teacherId, initial, hasLink }: PaymentLinkFormProps) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const busy = saving || removing;
  const url = `/api/teachers/${teacherId}/payment-link`;

  function update(next: string) {
    setValue(next);
    setFieldError('');
    setError('');
    setSuccess('');
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    const parsed = parsePaymentLink(value);
    if (!parsed.ok) {
      setFieldError(PAYMENT_LINK_MESSAGES[parsed.error]);
      return;
    }
    setFieldError('');
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentLink: value }),
      });
      if (!res.ok) {
        const { message } = await readError(res, 'Couldn’t save your payment link.');
        // One field, one issue: the message is the prefix and that issue's copy.
        if (message.startsWith(FIELD_PREFIX)) setFieldError(message.slice(FIELD_PREFIX.length));
        else setError(message);
        return;
      }
      setValue(parsed.url);
      setSuccess('Saved');
      router.refresh();
    } catch (err) {
      logRequestFailure('payment-link-form', { teacherId }, err);
      setError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setRemoveError('');
    setError('');
    setSuccess('');
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const { message } = await readError(res, 'Couldn’t remove your payment link.');
        setRemoveError(message);
        return;
      }
      setConfirming(false);
      setValue('');
      setFieldError('');
      setSuccess('Payment link removed.');
      router.refresh();
    } catch (err) {
      logRequestFailure('payment-link-form', { teacherId }, err);
      setRemoveError('Network error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <section className="mt-10 pt-6 border-t border-border flex flex-col gap-4">
      <h2 className="type-subtitle">Payment link</h2>
      <form onSubmit={handleSave} noValidate className="flex flex-col gap-4">
        <Input
          id="payment-link"
          label="Payment link"
          hint="A Tikkie, PayPal.me, Revolut or similar link without a fixed amount. Students see it next to what they owe."
          type="url"
          inputMode="url"
          autoComplete="off"
          value={value}
          error={fieldError}
          onChange={(e) => update(e.target.value)}
        />
        {error && <p role="alert" className="type-caption text-danger">{error}</p>}
        {success && <p role="status" className="type-caption text-teal">{success}</p>}
        <Button type="submit" variant="secondary" disabled={busy}>
          {saving ? 'Saving...' : 'Save payment link'}
        </Button>
      </form>
      {hasLink && (
        <RemoveControl
          label="payment link"
          question="Remove your payment link? Students with unpaid classes will no longer see it."
          confirming={confirming}
          removing={removing}
          disabled={busy}
          error={removeError}
          onAsk={() => { setRemoveError(''); setConfirming(true); }}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void handleRemove()}
        />
      )}
    </section>
  );
}
