import type { Currency } from '@/lib/prisma-client';
import { PaymentDetails } from '@/components/student/payment-details';
import { PaymentLinkPanel } from '@/components/student/payment-link-panel';
import { PaymentQr } from '@/components/student/payment-qr';
import { ProcessorPayButton } from '@/components/pay/processor-pay-button';
import { formatMoney } from '@/lib/format';
import { log } from '@/lib/log';
import { MOLLIE_METHODS } from '@/lib/processor-methods';
import type { PaymentMethod } from '@/lib/payment-methods';
import type { MethodAmount } from '@/lib/method-amount';

/** A method that can name no amount: a processor needs a `Payment` to collect. */
export type GiftMethod = Exclude<PaymentMethod, { kind: 'processor' }>;

/** The method with what it may name: a fixed amount owed against a payment, or none, for a gift. */
export type MethodPanelArm =
  | { method: PaymentMethod; amount: { kind: 'fixed'; amount: number }; paymentId: string }
  | { method: GiftMethod; amount: { kind: 'open' }; paymentId?: never };

export type MethodPanelProps = { currency: Currency; reference: string } & MethodPanelArm;

/**
 * One method's details, inside its chooser row. A fixed amount is owed and
 * named; an open one is a gift and names none.
 */
export function MethodPanel(props: MethodPanelProps) {
  const { amount, currency, reference } = props;
  if (isGift(props)) {
    return <ManualPanel method={props.method} amount={amount} currency={currency} reference={reference} />;
  }
  const { method, paymentId } = props;
  if (method.kind === 'processor') {
    return <ProcessorPayButton paymentId={paymentId} method={method.method} label={MOLLIE_METHODS[method.method].label} />;
  }
  return <ManualPanel method={method} amount={amount} currency={currency} reference={reference} />;
}

function isGift(props: MethodPanelProps): props is Extract<MethodPanelProps, { amount: { kind: 'open' } }> {
  return props.amount.kind === 'open';
}

function ManualPanel({
  method,
  amount,
  currency,
  reference,
}: {
  method: GiftMethod;
  amount: MethodAmount;
  currency: Currency;
  reference: string;
}) {
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
    default: {
      // A kind added to `PaymentMethod` without a panel fails the build here.
      const unhandled: never = method;
      log.error({ kind: String((unhandled as { kind?: unknown }).kind) }, 'pay page: unhandled payment method kind');
      return null;
    }
  }
}
