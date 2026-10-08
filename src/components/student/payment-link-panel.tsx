'use client';

import type { Currency } from '@prisma/client';
import { CopyFieldList } from '@/components/student/copy-field-list';
import { formatMoney } from '@/lib/format';

interface PaymentLinkPanelProps {
  url: string;
  host: string;
  amount: number;
  currency: Currency;
  reference: string;
}

/**
 * A teacher's payment link: the amount and reference to copy, and the link to
 * the page where the student pays. The link carries no amount, so the student
 * types it there.
 */
export function PaymentLinkPanel({ url, host, amount, currency, reference }: PaymentLinkPanelProps) {
  const shownAmount = formatMoney(amount, currency);
  return (
    <>
      <p className="type-body">
        Pay <span className="type-number">{shownAmount}</span> through the link, with this reference:
      </p>
      <CopyFieldList
        fields={[
          { key: 'amount', label: 'Amount', shown: shownAmount, copied: amount.toFixed(2) },
          { key: 'reference', label: 'Reference', shown: reference, copied: reference },
        ]}
      />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center justify-center gap-2 rounded-pill px-6 min-h-12 text-base font-semibold w-full sm:w-auto focus:outline-none focus-visible:shadow-focus border-[1.5px] border-transparent bg-teal text-cream hover:bg-teal-hover active:bg-teal-pressed no-underline text-center break-all"
      >
        Pay via {host}{' '}
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <p className="type-caption mt-2">Your teacher marks it as received once it arrives.</p>
    </>
  );
}
