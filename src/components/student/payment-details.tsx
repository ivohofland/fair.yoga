'use client';

import { useState } from 'react';
import type { BankDetails } from '@/lib/bank-details';

interface PaymentDetailsProps {
  details: BankDetails;
  beneficiary: string;
  reference: string;
}

type Field = { key: string; label: string; shown: string; copied: string };
type CopyState = { field: Field; outcome: 'copied' | 'failed' } | null;

/** The account rows of one scheme, in the order a banking app asks for them. */
function accountFields(details: BankDetails): Field[] {
  switch (details.scheme) {
    case 'sepa':
    case 'iban':
      return [
        // Copied without the display grouping: some bank apps cap the field at the
        // IBAN's bare length and would cut a pasted, spaced one short.
        { key: 'IBAN', label: 'IBAN', shown: details.iban, copied: details.iban.replace(/\s/g, '') },
        ...(details.bic === null ? [] : [{ key: 'BIC', label: 'BIC', shown: details.bic, copied: details.bic }]),
      ];
    case 'uk':
      return [
        // Shown in the 12-34-56 grouping UK banks print; copied as bare digits.
        {
          key: 'sort code',
          label: 'Sort code',
          shown: details.sortCode.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3'),
          copied: details.sortCode,
        },
        { key: 'account number', label: 'Account number', shown: details.accountNumber, copied: details.accountNumber },
      ];
    case 'us':
      return [
        { key: 'routing number', label: 'Routing number', shown: details.routingNumber, copied: details.routingNumber },
        { key: 'account number', label: 'Account number', shown: details.accountNumber, copied: details.accountNumber },
      ];
    default: {
      const unhandled: never = details;
      console.error('[payment-details] unhandled bank scheme', { scheme: String((unhandled as { scheme?: unknown }).scheme) });
      return [];
    }
  }
}

/**
 * The transfer details, each copyable on its own.
 */
export function PaymentDetails({ details, beneficiary, reference }: PaymentDetailsProps) {
  const [state, setState] = useState<CopyState>(null);

  const fields: ReadonlyArray<Field> = [
    { key: 'name', label: 'Name', shown: beneficiary, copied: beneficiary },
    ...accountFields(details),
    { key: 'reference', label: 'Reference', shown: reference, copied: reference },
  ];

  function copy(field: Field): void {
    if (!navigator.clipboard?.writeText) {
      console.warn('[payment-details] no clipboard API; the copy was not attempted');
      setState({ field, outcome: 'failed' });
      return;
    }

    navigator.clipboard
      .writeText(field.copied)
      .then(() => {
        setState({ field, outcome: 'copied' });
        setTimeout(() => setState((s) => (s?.field === field && s.outcome === 'copied' ? null : s)), 2000);
      })
      // A refusal (permissions, insecure context) is ordinary, not a fault:
      // the value stays on screen, selectable by hand.
      .catch((err: unknown) => {
        console.warn('[payment-details] the clipboard refused the copy', err);
        setState({ field, outcome: 'failed' });
      });
  }

  return (
    <>
      <dl className="mt-1">
        {fields.map((field) => (
          <div key={field.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 py-1.5">
            <dt className="type-caption col-start-1">{field.label}</dt>
            <dd className="type-body text-ink tabular-nums break-words select-all col-start-1 min-w-0">{field.shown}</dd>
            <dd className="col-start-2 row-start-1 row-span-2">
              <button
                type="button"
                onClick={() => copy(field)}
                aria-label={`Copy ${field.key}`}
                className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint"
              >
                {state?.field.key === field.key && state.outcome === 'copied' ? 'Copied' : 'Copy'}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      {/* Visible only for a refusal; a successful copy already shows on its
          button, and this line carries it to a screen reader. */}
      <p role="status" className={state?.outcome === 'failed' ? 'type-caption text-brown mt-1' : 'sr-only'}>
        {state === null
          ? ''
          : state.outcome === 'copied'
            ? `${state.field.label} copied`
            : `Couldn’t copy the ${state.field.key} — press and hold it to select`}
      </p>
    </>
  );
}
