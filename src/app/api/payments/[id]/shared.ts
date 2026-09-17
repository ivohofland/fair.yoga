import type { NextResponse } from 'next/server';
import { Prisma, type Payment } from '@prisma/client';
import { API_ERROR_STATUS } from '@/lib/api-error-codes';
import { respondError, respondOk, respondUnchanged } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { PAYMENT_GONE, type PaymentOutcome, type PaymentRefusal } from '@/services/payments';

/**
 * Shared by this resource's `route.ts` files: the answer-building functions
 * (`respondPaymentRefusal`, `respondPaymentOutcome`) and the ownership gate
 * (`loadOwnedPayment`) a POST door runs before calling into the service. A
 * file of its own because a `route.ts` may export only HTTP verbs and Next's
 * config names.
 */

/** A refusal from `services/payments.ts`, at the status its code is registered with. */
export function respondPaymentRefusal(refusal: PaymentRefusal): NextResponse {
  return respondError(refusal.message, API_ERROR_STATUS[refusal.code], refusal.code);
}

/** What a payment action did. `data` is the payment row whether or not this call wrote it. */
export function respondPaymentOutcome(outcome: PaymentOutcome): NextResponse {
  switch (outcome.kind) {
    case 'applied':
      return respondOk(outcome.payment);
    case 'unchanged':
      return respondUnchanged<Payment>(outcome.payment);
    case 'refused':
      return respondPaymentRefusal(outcome.refusal);
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled payment outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}

const OWNED_PAYMENT_INCLUDE = {
  registration: {
    include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
  },
} satisfies Prisma.PaymentInclude;

/**
 * The ownership preamble the POST doors under this resource share: read the
 * payment through its registration → class → calendarEntry chain, answer the
 * service's own not-found refusal (`PAYMENT_GONE`) if the row is gone, and 403
 * if it belongs to another teacher.
 *
 * A discriminated result, not a bare `NextResponse | null`: `ok` names the
 * call site's branch (`if (!owned.ok) return owned.response;`) the same way
 * `PaymentOutcome`'s `kind` does for the service's own callers.
 */
export type OwnedPayment = { readonly ok: true } | { readonly ok: false; readonly response: NextResponse };

export async function loadOwnedPayment(paymentId: string, teacherId: string): Promise<OwnedPayment> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: OWNED_PAYMENT_INCLUDE,
  });

  if (!payment) return { ok: false, response: respondPaymentRefusal(PAYMENT_GONE) };
  if (payment.registration.class.calendarEntry.teacherId !== teacherId) {
    return { ok: false, response: respondError('Access denied', 403) };
  }
  return { ok: true };
}
