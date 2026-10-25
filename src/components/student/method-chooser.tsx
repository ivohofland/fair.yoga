import { MethodPanel, type MethodPanelProps } from '@/components/student/method-panel';
import { PAYMENT_METHOD_COPY, paymentMethodLabel, type PaymentMethod } from '@/lib/payment-methods';

export type MethodChooserProps = {
  /** The shared `name` of the rows: opening one closes the others. */
  name: string;
  methods: PaymentMethod[];
} & Pick<MethodPanelProps, 'currency' | 'reference'> &
  (
    | { amount: { kind: 'fixed'; amount: number }; paymentId: string }
    | { amount: { kind: 'open' }; paymentId?: never }
  );

/** The student's list of ways to pay or give, one closed row per method. */
export function MethodChooser({ name, methods, ...panel }: MethodChooserProps) {
  return (
    <div className="border-t border-border">
      {methods.map((method) => (
        <details
          key={`${method.kind}:${method.kind === 'processor' ? method.method : ''}`}
          name={name}
          className="border-b border-border"
        >
          <summary className="min-h-14 py-3 cursor-pointer">
            <span className="text-base text-ink">{paymentMethodLabel(method)}</span>
            <span className="block type-caption">{PAYMENT_METHOD_COPY[method.kind].hint}</span>
          </summary>
          <div className="pb-4">
            <MethodPanel method={method} {...panel} />
          </div>
        </details>
      ))}
    </div>
  );
}
