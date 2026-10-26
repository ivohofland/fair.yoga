import type { ReactNode } from 'react';
import { MethodPanel, type MethodPanelArm, type MethodPanelProps } from '@/components/student/method-panel';
import { PAYMENT_METHOD_COPY, paymentMethodLabel, type PaymentMethod } from '@/lib/payment-methods';

/** Each `MethodPanelArm`, with its one `method` widened to the list of them. */
type ChooserArm<A> = A extends { method: infer M } ? Omit<A, 'method'> & { methods: M[] } : never;

export type MethodChooserProps = {
  /** The shared `name` of the rows: opening one closes the others. */
  name: string;
} & Pick<MethodPanelProps, 'currency' | 'reference'> &
  ChooserArm<MethodPanelArm>;

/** The student's list of ways to pay or give, one closed row per method. */
export function MethodChooser(props: MethodChooserProps) {
  const { name, currency, reference } = props;
  const rows: { method: PaymentMethod; panel: ReactNode }[] = isGiftList(props)
    ? props.methods.map((method) => ({
      method,
      panel: <MethodPanel method={method} amount={props.amount} currency={currency} reference={reference} />,
    }))
    : props.methods.map((method) => ({
      method,
      panel: (
        <MethodPanel
          method={method}
          amount={props.amount}
          paymentId={props.paymentId}
          currency={currency}
          reference={reference}
        />
      ),
    }));
  return (
    <div className="border-t border-border">
      {rows.map(({ method, panel }) => (
        <details
          key={`${method.kind}:${method.kind === 'processor' ? method.method : ''}`}
          name={name}
          className="border-b border-border"
        >
          <summary className="min-h-14 py-3 cursor-pointer">
            <span className="text-base text-ink">{paymentMethodLabel(method)}</span>
            <span className="block type-caption">{PAYMENT_METHOD_COPY[method.kind].hint}</span>
          </summary>
          <div className="pb-4">{panel}</div>
        </details>
      ))}
    </div>
  );
}

function isGiftList(props: MethodChooserProps): props is Extract<MethodChooserProps, { amount: { kind: 'open' } }> {
  return props.amount.kind === 'open';
}
