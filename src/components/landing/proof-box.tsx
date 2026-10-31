import Link from 'next/link';
import { PRICING_EXAMPLES, examplePreview } from '@/lib/pricing-examples';
import { CURRENCY_PREFIX, formatMoney } from '@/lib/format';

const EXAMPLE = PRICING_EXAMPLES.typical;
const CURRENCY = 'EUR';

/** A whole-unit amount for the caption, in the example's currency. */
const whole = (amount: number): string => `${CURRENCY_PREFIX[CURRENCY]}${amount}`;

/** The Pricing card's worked example, computed by the same preview the calculator uses. */
export function ProofBox() {
  const { prices, teacherRate } = examplePreview('typical');
  const figures = [
    { label: 'lowest tier pays', amount: prices[1] },
    { label: 'highest tier pays', amount: prices[5] },
    { label: 'you earn', amount: teacherRate },
  ];
  return (
    <div
      role="group"
      aria-label="Example class"
      className="bg-cream border border-border rounded-field p-4 flex flex-col gap-3"
    >
      <p className="text-[13px] text-brown">
        Example: {EXAMPLE.students} students, a {whole(EXAMPLE.roomCost)} room, your target{' '}
        {whole(EXAMPLE.targetRate)}
      </p>
      <dl className="grid grid-cols-3 gap-3">
        {figures.map((f) => (
          <div key={f.label} className="flex flex-col-reverse gap-1">
            <dt className="text-[13px] text-brown">{f.label}</dt>
            <dd className="type-number text-teal">{formatMoney(f.amount, CURRENCY)}</dd>
          </div>
        ))}
      </dl>
      <Link href="/sliding-scale#examples" className="text-sm self-start">
        See more examples →
      </Link>
    </div>
  );
}
