import { z } from 'zod';
import { Prisma, ProcessorRefundStatus, type PrismaClient, type RefundOutcome } from '@/lib/prisma-client';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { setLockTimeout } from '@/lib/db-locks';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import { MollieUnavailable, type RefundAnswer } from '@/lib/mollie/client';
import type { MollieDeps } from './mollie-deps';
import { completeRefund } from './processor-attempts';
import { getAccessToken } from './processor-token';

/** What the teacher chose for the payment a refunded attempt settled: no longer owed, or owed again. */
export type RefundChoice = 'waive' | 'ask_again';

export type RefundRefusal = Extract<
  CodedRefusal,
  { code: 'NOT_FOUND' | 'REFUND_NOT_ALLOWED' | 'REFUND_ALREADY_REQUESTED' | 'REFUND_REFUSED' | 'PROCESSOR_NOT_CONNECTED' }
>;

export type RefundResult =
  // `outcomeApplied`: the refund completed in this call (Mollie answered `refunded`) and its outcome applied.
  | { kind: 'requested'; refundStatus: ProcessorRefundStatus; outcomeApplied: boolean }
  | { kind: 'invalid'; message: string }
  | { kind: 'refused'; refusal: RefundRefusal }
  | { kind: 'unavailable' };

const refundStatusSchema = z.enum(ProcessorRefundStatus);

const OUTCOME_OF: Record<RefundChoice, RefundOutcome> = { waive: 'waived', ask_again: 'reopened' };

/** The attempt columns the intent reads under the payment's lock. */
const INTENT_ATTEMPT_SELECT = {
  id: true,
  status: true,
  settledPayment: true,
  chargedBackAt: true,
  amount: true,
  currency: true,
  processorPaymentId: true,
  connectionId: true,
  testmode: true,
  payment: { select: { status: true } },
} as const satisfies Prisma.ProcessorPaymentSelect;

type Intent =
  | {
      kind: 'recorded';
      refundId: string;
      outcome: RefundOutcome | null;
      connectionId: string;
      attempt: Prisma.ProcessorPaymentGetPayload<{ select: typeof INTENT_ATTEMPT_SELECT }>;
    }
  | Exclude<RefundResult, { kind: 'requested' | 'unavailable' }>;

/** The teacher's copy for a refund Mollie would not take. */
function refusedCopy(detail: string): string {
  return /balance/i.test(detail)
    ? 'Your Mollie balance is too low for this refund. Top it up in Mollie, then try again.'
    : `Mollie didn’t accept this refund: ${detail}`;
}

/**
 * Refunds one Mollie-paid attempt in full, from the teacher's Mollie balance,
 * in spec §6's order, because the money is the irreversible part:
 *
 * 1. The intent: under the payment's row lock (`FOR UPDATE`, and no other
 *    lock), the attempt is checked and a `queued` `ProcessorRefund` with no
 *    Mollie id is inserted. `ProcessorRefund_one_live_per_attempt` turns a
 *    second live refund of the attempt into `REFUND_ALREADY_REQUESTED`.
 *    `choice` is required exactly when the attempt settled the payment, and
 *    becomes the row's `outcome`.
 * 2. The money: `createRefund`, outside any transaction, in the mode the
 *    attempt was made in.
 * 3. Mollie's answer: anything short of an accepted refund (a refusal, no
 *    answer, no usable token, no Mollie configuration) deletes the row step 1
 *    inserted, by its id. An accepted refund stores its Mollie id and status;
 *    when that status is already `refunded` the outcome applies in the same
 *    transaction (`completeRefund`). Otherwise the payment stays `paid`, and
 *    the outcome waits for a sync of the attempt (`syncAttempt`).
 *
 * A crash between steps 1 and 3 leaves the row with no Mollie id.
 * Lock order: `docs/lock-order.md`, "The `Payment` row is a Mollie sync's gate".
 */
export async function refundAttempt(
  db: PrismaClient,
  deps: MollieDeps | null,
  input: { paymentId: string; attemptId: string; choice: RefundChoice | null; now?: Date },
): Promise<RefundResult> {
  const now = input.now ?? new Date();
  const intent = await db.$transaction(async (tx): Promise<Intent> => {
    await setLockTimeout(tx);
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
    const attempt = await tx.processorPayment.findFirst({
      where: { id: input.attemptId, paymentId: input.paymentId },
      select: INTENT_ATTEMPT_SELECT,
    });
    if (!attempt) return { kind: 'refused', refusal: codedRefusal('NOT_FOUND', 'This payment no longer exists.') };
    if (attempt.status !== 'paid') {
      return { kind: 'refused', refusal: codedRefusal('REFUND_NOT_ALLOWED', 'Only a completed Mollie payment can be refunded.') };
    }
    if (attempt.chargedBackAt !== null) {
      return { kind: 'refused', refusal: codedRefusal('REFUND_NOT_ALLOWED', 'The student’s bank already took this payment back.') };
    }
    if (attempt.connectionId === null) {
      return { kind: 'refused', refusal: codedRefusal('PROCESSOR_NOT_CONNECTED', 'Mollie is no longer connected.') };
    }
    const settles = attempt.settledPayment && attempt.payment.status === 'paid';
    if (settles !== (input.choice !== null)) {
      return {
        kind: 'invalid',
        message: settles ? 'Choose whether to waive the payment or ask again.' : 'This payment was a duplicate; there is nothing to waive.',
      };
    }
    const outcome = input.choice === null ? null : OUTCOME_OF[input.choice];
    try {
      const refund = await tx.processorRefund.create({
        data: { attemptId: attempt.id, amount: attempt.amount, status: 'queued', outcome },
        select: { id: true },
      });
      return { kind: 'recorded', refundId: refund.id, outcome, connectionId: attempt.connectionId, attempt };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { kind: 'refused', refusal: codedRefusal('REFUND_ALREADY_REQUESTED', 'A refund for this payment is already on its way.') };
      }
      throw err;
    }
  });
  if (intent.kind !== 'recorded') return intent;

  const { refundId, outcome, connectionId, attempt } = intent;
  const withdraw = async (): Promise<void> => {
    await db.processorRefund.deleteMany({ where: { id: refundId } });
  };

  if (deps === null) {
    await withdraw();
    return { kind: 'unavailable' };
  }
  const token = await getAccessToken(db, deps, connectionId, now);
  if (token.kind !== 'token') {
    await withdraw();
    return { kind: 'unavailable' };
  }

  let answer: RefundAnswer;
  try {
    answer = await deps.client.createRefund(token.accessToken, attempt.processorPaymentId, {
      amount: { value: attempt.amount.toFixed(2), currency: attempt.currency },
      testmode: attempt.testmode,
    });
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    await withdraw();
    logDegraded(
      'MOLLIE_UNAVAILABLE',
      { connectionId, operation: 'createRefund', ...(err.status === null ? {} : { status: err.status }) },
      'Mollie could not take a refund; the teacher was told to try again',
      err,
    );
    return { kind: 'unavailable' };
  }
  if (answer.kind === 'refused') {
    await withdraw();
    log.info({ attemptId: attempt.id, detail: answer.detail, field: answer.field }, 'Mollie refused a refund');
    return { kind: 'refused', refusal: codedRefusal('REFUND_REFUSED', refusedCopy(answer.detail)) };
  }

  const parsed = refundStatusSchema.safeParse(answer.refund.status);
  if (!parsed.success) {
    log.warn({ attemptId: attempt.id, refundId: answer.refund.id, status: answer.refund.status }, 'Mollie reported a refund status fair.yoga does not know');
  }
  const refundStatus: ProcessorRefundStatus = parsed.success ? parsed.data : 'queued';
  const mollieRefundId = answer.refund.id;

  const outcomeApplied = await db.$transaction(async (tx): Promise<boolean> => {
    await setLockTimeout(tx);
    // An ask-again completes through `reopenInTransaction`, which takes the
    // `TeacherStudent` link before the payment; every other path locks the
    // payment here first.
    const completesReopen = refundStatus === 'refunded' && outcome === 'reopened';
    if (!completesReopen) await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${input.paymentId} FOR UPDATE`;
    const applied =
      refundStatus === 'refunded' &&
      (await completeRefund(tx, { paymentId: input.paymentId, attemptId: attempt.id, outcome, now })) === 'applied';
    await tx.processorRefund.update({ where: { id: refundId }, data: { processorRefundId: mollieRefundId, status: refundStatus } });
    return applied;
  });
  return { kind: 'requested', refundStatus, outcomeApplied };
}
