'use client';

import { useState } from 'react';

interface PaymentDetailsProps {
  iban: string;
  beneficiary: string;
  reference: string;
}

type Field = { key: string; label: string; shown: string; copied: string };
type CopyState = { field: Field; outcome: 'copied' | 'failed' } | null;

/**
 * The transfer details, each copyable on its own.
 */
export function PaymentDetails({ iban, beneficiary, reference }: PaymentDetailsProps) {
  const [state, setState] = useState<CopyState>(null);

  const fields: ReadonlyArray<Field> = [
    { key: 'name', label: 'Name', shown: beneficiary, copied: beneficiary },
    // Copied without the display grouping: some bank apps cap the field at the
    // IBAN's bare length and would cut a pasted, spaced one short.
    { key: 'IBAN', label: 'IBAN', shown: iban, copied: iban.replace(/\s/g, '') },
    { key: 'reference', label: 'Reference', shown: reference, copied: reference },
  ];

  function copy(field: Field): void {
    if (!navigator.clipboard?.writeText) {
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
