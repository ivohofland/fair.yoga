import type { Currency } from '@/lib/prisma-client';
import { PaymentDetails } from '@/components/student/payment-details';
import { PaymentLinkPanel } from '@/components/student/payment-link-panel';
import { PaymentQr } from '@/components/student/payment-qr';
import { ProcessorPayButton } from '@/components/pay/processor-pay-button';
import { formatMoney } from '@/lib/format';
import { log } from '@/lib/log';
import { MOLLIE_METHODS } from '@/lib/processor-methods';
import type { PaymentMethod } from '@/lib/payment-methods';

export type MethodPanelProps = { method: PaymentMethod; currency: Currency; reference: string } & (
  | { amount: { kind: 'fixed'; amount: number }; paymentId: string }
  | { amount: { kind: 'open' }; paymentId?: never }
);

/**
 * One method's details, inside its chooser row. A fixed amount is owed and
 * named; an open one is a gift and names none. A processor method needs a
 * payment to pay, so it has no open form.
 */
export function MethodPanel(props: MethodPanelProps) {
  const { method, amount, currency, reference } = props;
  switch (method.kind) {
    case 'bank_transfer':
      return (
        <>
          <p className="type-body">
            {amount.kind === 'fixed' ? (
              <>
                Transfer <span className="type-number">{formatMoney(amount.amount, currency)}</span> to:
              </>
            ) : (
              'Transfer to:'
            )}
          </p>
          <PaymentDetails details={method.details} beneficiary={method.beneficiary} reference={reference} />
        </>
      );
    case 'epc_qr':
      return (
        <PaymentQr
          iban={method.iban}
          bic={method.bic}
          beneficiary={method.beneficiary}
          amount={amount}
          currency={method.currency}
          remittance={reference}
        />
      );
    case 'payment_link':
      return (
        <PaymentLinkPanel
          url={method.url}
          host={method.host}
          amount={amount}
          currency={currency}
          reference={reference}
        />
      );
    case 'processor':
      if (props.amount.kind === 'open' || props.paymentId === undefined) {
        log.error({ kind: 'processor' }, 'method panel: a processor method cannot take an open amount');
        return null;
      }
      return <ProcessorPayButton paymentId={props.paymentId} method={method.method} label={MOLLIE_METHODS[method.method].label} />;
    default: {
      // A kind added to `PaymentMethod` without a panel fails the build here.
      const unhandled: never = method;
      log.error({ kind: String((unhandled as { kind?: unknown }).kind) }, 'pay page: unhandled payment method kind');
      return null;
    }
  }
}
