import type { Currency } from '@/lib/prisma-client';
import { formatMoney } from '@/lib/format';
import { vatThousandths, withVat } from '@/lib/vat';

interface DonationSummaryProps {
  roomCost: number;
  vatPercent: number;
  currency: Currency;
}

/** What a donation class shows where a tiered one shows its pricing: no estimate, only the break-even. */
export function DonationSummary({ roomCost, vatPercent, currency }: DonationSummaryProps) {
  const room = formatMoney(roomCost, currency);
  return (
    <div className="py-6">
      <h2 className="type-subtitle mb-3">Pricing</h2>
      <p className="type-body">By donation</p>
      <p className="type-caption mt-1">
        {vatPercent > 0
          ? `Room cost ${room}: your break-even is ${formatMoney(withVat(roomCost, vatThousandths(vatPercent)), currency)} in donations, VAT included.`
          : `Room cost ${room}: your break-even.`}
      </p>
    </div>
  );
}
