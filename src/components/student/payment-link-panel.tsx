'use client';

import type { Currency } from '@/lib/prisma-client';
import { CopyFieldList } from '@/components/student/copy-field-list';
import { formatMoney } from '@/lib/format';
import type { MethodAmount } from '@/lib/method-amount';

interface PaymentLinkPanelProps {
  url: string;
  host: string;
  amount: MethodAmount;
  currency: Currency;
  reference: string;
}

/**
 * A teacher's payment link: the reference to copy (and the amount, when one is
 * owed), and the link to the page where the student pays. The link carries no
 * amount, so the student types it there. An open amount is a gift: the panel
 * names none and does not say the teacher will mark it received.
 */
export function PaymentLinkPanel({ url, host, amount, currency, reference }: PaymentLinkPanelProps) {
  const referenceField = { key: 'reference', label: 'Reference', shown: reference, copied: reference } as const;
  const shownAmount = amount.kind === 'fixed' ? formatMoney(amount.amount, currency) : null;
  return (
    <>
      <p className="type-body">
        {amount.kind === 'fixed' ? (
          <>
            Pay <span className="type-number">{shownAmount}</span> through the link, with this reference:
          </>
        ) : (
          'Give through the link, with this reference:'
        )}
      </p>
      <CopyFieldList
        fields={
          amount.kind === 'fixed' && shownAmount !== null
            ? [{ key: 'amount', label: 'Amount', shown: shownAmount, copied: amount.amount.toFixed(2) }, referenceField]
            : [referenceField]
        }
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center justify-center gap-2 rounded-pill px-6 min-h-12 text-base font-semibold w-full sm:w-auto focus:outline-none focus-visible:shadow-focus border-[1.5px] border-transparent bg-teal text-cream hover:bg-teal-hover active:bg-teal-pressed no-underline text-center break-all"
      >
        {`${amount.kind === 'fixed' ? 'Pay' : 'Give'} via ${host}`}{' '}
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      {amount.kind === 'fixed' && <p className="type-caption mt-2">Your teacher marks it as received once it arrives.</p>}
    </>
  );
}
