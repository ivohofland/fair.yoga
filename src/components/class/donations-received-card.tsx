'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Currency } from '@/lib/prisma-client';
import { formatMoney, formatMoneyCents } from '@/lib/format';
import { includedVatCents, vatThousandths } from '@/lib/vat';
import { MONEY_DECIMALS } from '@/lib/input-bounds';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import { NumberInput } from '@/components/ui/number-input';
import { Button } from '@/components/ui/button';

interface DonationsReceivedCardProps {
  classId: string;
  /** What the teacher recorded; `null` is not recorded, which is not the same as 0. */
  donationTotal: number | null;
  vatPercent: number;
  currency: Currency;
}

export function DonationsReceivedCard({ classId, donationTotal, vatPercent, currency }: DonationsReceivedCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(donationTotal ?? 0);
  // `NumberInput` holds 0 for an empty field, so with nothing recorded the
  // draft is only an amount once the teacher has typed it.
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function put(amount: number | null) {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/classes/${classId}/donation-total`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not save. Try again.'));
      }
    } catch (err) {
      logRequestFailure('donations-received-card', { classId }, err);
      setError('Could not save. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function startEditing() {
    setDraft(donationTotal ?? 0);
    setTouched(false);
    setEditing(true);
  }

  const vatCents =
    donationTotal !== null && vatPercent > 0
      ? includedVatCents(Math.round(donationTotal * 100), vatThousandths(vatPercent))
      : null;

  return (
    <div className="py-6">
      <div className="bg-sand-soft border border-border rounded-card p-5">
        <h2 className="type-subtitle mb-3">Donations received</h2>
        {editing ? (
          <div className="flex flex-col gap-3">
            <NumberInput
              id="donation-total"
              label={`Total received (${currency})`}
              decimals={MONEY_DECIMALS}
              value={draft}
              onValueChange={(v) => {
                setDraft(v);
                setTouched(true);
              }}
            />
            <div className="flex items-center gap-3">
              <Button type="button" onClick={() => put(draft)} disabled={submitting || Number.isNaN(draft) || (donationTotal === null && !touched)}>
                {submitting ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)} disabled={submitting}>
                Cancel
              </Button>
            </div>
          </div>
        ) : donationTotal === null ? (
          <div className="flex items-center justify-between gap-3">
            <p className="type-caption">Not recorded yet</p>
            <button type="button" onClick={startEditing} className="type-label text-teal">
              Record
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="type-number text-[28px] leading-[1.25]">{formatMoney(donationTotal, currency)}</p>
              {vatCents !== null && (
                <p className="type-caption">incl. {formatMoneyCents(vatCents, currency)} VAT</p>
              )}
            </div>
            <div className="flex items-center gap-4">
              <button type="button" onClick={startEditing} disabled={submitting} className="type-label text-teal disabled:opacity-50">
                Edit
              </button>
              <button type="button" onClick={() => put(null)} disabled={submitting} className="type-label text-teal disabled:opacity-50">
                Clear
              </button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="type-caption text-danger mt-2">{error}</p>}
      </div>
    </div>
  );
}
