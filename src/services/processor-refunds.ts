import { Prisma, type ProcessorRefundStatus, type PrismaClient, type RefundOutcome } from '@/lib/prisma-client';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { setLockTimeout } from '@/lib/db-locks';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import { isRefundStatus, refundEndedAtMollie } from '@/lib/processor-refund-status';
import { MollieUnavailable, type MollieRefundView, type RefundAnswer } from '@/lib/mollie/client';
import type { MollieDeps } from './mollie-deps';
import { completeRefund, notifyRefundFailed } from './processor-attempts';
import { getAccessToken } from './processor-token';
import { ADOPT_AFTER_MS, refundMatches } from './refund-adoption';
import { lockTeacherStudentLink } from './roster-link';

/** What the teacher chose for the payment a refunded attempt settled: no longer owed, or owed again. */
export type RefundChoice = 'waive' | 'ask_again';

export type RefundRefusal = Extract<
  CodedRefusal,
  { code: 'NOT_FOUND' | 'REFUND_NOT_ALLOWED' | 'REFUND_ALREADY_REQUESTED' | 'REFUND_REFUSED' | 'PROCESSOR_NOT_CONNECTED' }
>;

export type RefundResult =
  // `outcomeApplied`: the refund completed in this call (Mollie answered `refunded`) and its outcome applied.
  | { kind: 'requested'; refundStatus: ProcessorRefundStatus; outcomeApplied: boolean }
  // The attempt's refund is already `refunded`.
  | { kind: 'unchanged' }
  | { kind: 'invalid'; message: string }
  | { kind: 'refused'; refusal: RefundRefusal }
  | { kind: 'unavailable' };

const OUTCOME_OF: Record<RefundChoice, RefundOutcome> = { waive: 'waived', ask_again: 'reopened' };

const ALREADY_REQUESTED: RefundRefusal = codedRefusal('REFUND_ALREADY_REQUESTED', 'A refund for this payment is already on its way.');

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
  refunds: { select: { id: true, status: true, outcome: true, processorRefundId: true, requestedAt: true } },
  payment: {
    select: {
      status: true,
      registration: { select: { studentId: true, classId: true, class: { select: { calendarEntry: { select: { teacherId: true } } } } } },
    },
  },
} as const satisfies Prisma.ProcessorPaymentSelect;

type IntentAttempt = Prisma.ProcessorPaymentGetPayload<{ select: typeof INTENT_ATTEMPT_SELECT }>;

/** One intent row and what its call needs after the intent's transaction. */
type Held = {
  refundId: string;
  outcome: RefundOutcome | null;
  paymentId: string;
  connectionId: string;
  attempt: IntentAttempt;
  now: Date;
};

type Intent =
  | ({ kind: 'recorded' } & Held)
  | ({ kind: 'stale' } & Held)
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
 *    Mollie id is inserted. `choice` is required exactly when the attempt
 *    settled the payment, and becomes the row's `outcome`. An attempt whose
 *    refund is already `refunded` answers `unchanged`. An earlier intent
 *    still without a Mollie id refuses `REFUND_ALREADY_REQUESTED` while it is
 *    younger than `ADOPT_AFTER_MS`; an older one is reconciled first (below)
 *    and, when Mollie has no refund for it, withdrawn before this intent is
 *    recorded. `ProcessorRefund_one_live_per_attempt` refuses any other second
 *    live refund of the attempt.
 * 2. The money: `createRefund`, outside any transaction, in the mode the
 *    attempt was made in.
 * 3. Mollie's answer. The intent is withdrawn (deleted by its id) only when
 *    no refund can exist at Mollie: no Mollie configuration, no usable token
 *    or a throw while getting one, or a refusal. A failure that leaves it
 *    unknown — `createRefund` throwing — is reconciled once against the
 *    refunds Mollie lists on the payment: one no row holds, for this amount,
 *    is adopted as this call's refund; with none the intent is withdrawn;
 *    when Mollie cannot be asked either, the intent is kept and logged. An
 *    accepted or adopted refund's Mollie id and status are stored in one
 *    transaction, which applies the outcome when the status is `refunded`
 *    (`completeRefund`) and tells the teacher when it is `failed`. If that
 *    transaction fails, Mollie's refund id is logged and the error rethrown.
 *
 * An intent kept without its Mollie id — after either logged failure, or a
 * crash between steps 1 and 3 — is reconciled by the attempt's next refund
 * request once it is older than `ADOPT_AFTER_MS`; `adoptionFor` is the rule
 * by which a sync adopts a Mollie refund into it.
 * Lock order: `docs/lock-order.md`, "The `Payment` row is a Mollie sync's gate".
 */
export async function refundAttempt(
  db: PrismaClient,
  deps: MollieDeps | null,
  input: { paymentId: string; attemptId: string; choice: RefundChoice | null; now?: Date },
): Promise<RefundResult> {
  const now = input.now ?? new Date();
  const first = await recordIntent(db, input, now);
  if (first.kind !== 'stale') return first.kind === 'recorded' ? requestRefund(db, deps, first) : first;

  const reconciled = await reconcileStale(db, deps, first);
  if (reconciled !== 'withdrawn') return reconciled;
  const second = await recordIntent(db, input, now);
  if (second.kind === 'stale') return { kind: 'refused', refusal: ALREADY_REQUESTED };
  return second.kind === 'recorded' ? requestRefund(db, deps, second) : second;
}

async function recordIntent(
  db: PrismaClient,
  input: { paymentId: string; attemptId: string; choice: RefundChoice | null },
  now: Date,
): Promise<Intent> {
  return db.$transaction(async (tx): Promise<Intent> => {
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
    if (attempt.refunds.some((r) => r.status === 'refunded')) return { kind: 'unchanged' };
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
    const held = { paymentId: input.paymentId, connectionId: attempt.connectionId, attempt, now };
    const awaiting = attempt.refunds
      .filter((r) => r.processorRefundId === null)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())[0];
    if (awaiting !== undefined) {
      if (now.getTime() - awaiting.requestedAt.getTime() < ADOPT_AFTER_MS) return { kind: 'refused', refusal: ALREADY_REQUESTED };
      return { kind: 'stale', refundId: awaiting.id, outcome: awaiting.outcome, ...held };
    }
    const outcome = input.choice === null ? null : OUTCOME_OF[input.choice];
    try {
      const refund = await tx.processorRefund.create({
        data: { attemptId: attempt.id, amount: attempt.amount, status: 'queued', outcome },
        select: { id: true },
      });
      return { kind: 'recorded', refundId: refund.id, outcome, ...held };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { kind: 'refused', refusal: ALREADY_REQUESTED };
      }
      throw err;
    }
  });
}

/** Deletes the intent by its id, unless a sync has adopted a Mollie refund into it meanwhile. */
async function withdraw(db: PrismaClient, intent: Held): Promise<void> {
  await db.processorRefund.deleteMany({ where: { id: intent.refundId, processorRefundId: null } });
}

async function requestRefund(db: PrismaClient, deps: MollieDeps | null, intent: Held): Promise<RefundResult> {
  const { attempt, connectionId } = intent;
  if (deps === null) {
    await withdraw(db, intent);
    return { kind: 'unavailable' };
  }
  let token: Awaited<ReturnType<typeof getAccessToken>>;
  try {
    token = await getAccessToken(db, deps, connectionId, intent.now);
  } catch (err) {
    await withdraw(db, intent);
    throw err;
  }
  if (token.kind !== 'token') {
    await withdraw(db, intent);
    return { kind: 'unavailable' };
  }

  let answer: RefundAnswer;
  try {
    answer = await deps.client.createRefund(token.accessToken, attempt.processorPaymentId, {
      amount: { value: attempt.amount.toFixed(2), currency: attempt.currency },
      testmode: attempt.testmode,
    });
  } catch (err) {
    if (err instanceof MollieUnavailable) {
      logDegraded(
        'MOLLIE_UNAVAILABLE',
        { connectionId, operation: 'createRefund', ...(err.status === null ? {} : { status: err.status }) },
        'Mollie gave no usable answer to a refund; asking it which refunds the payment has',
        err,
      );
    } else {
      log.warn({ attemptId: attempt.id, refundId: intent.refundId, err }, 'a refund request failed unread; asking Mollie which refunds the payment has');
    }
    const found = await unheldRefund(db, deps, token.accessToken, intent);
    switch (found.kind) {
      case 'found':
        return storeAnswer(db, intent, found.refund);
      case 'none':
        await withdraw(db, intent);
        return { kind: 'unavailable' };
      case 'failed':
        return { kind: 'unavailable' };
      default: {
        const unhandled: never = found;
        throw new Error(`unhandled reconcile: ${String(unhandled)}`);
      }
    }
  }
  if (answer.kind === 'refused') {
    await withdraw(db, intent);
    log.info({ attemptId: attempt.id, detail: answer.detail, field: answer.field }, 'Mollie refused a refund');
    return { kind: 'refused', refusal: codedRefusal('REFUND_REFUSED', refusedCopy(answer.detail)) };
  }
  return storeAnswer(db, intent, answer.refund);
}

/** An intent older than `ADOPT_AFTER_MS` with no Mollie id: adopted, withdrawn so a new one can be recorded, or left while Mollie cannot say. */
async function reconcileStale(db: PrismaClient, deps: MollieDeps | null, intent: Held): Promise<RefundResult | 'withdrawn'> {
  if (deps === null) return { kind: 'unavailable' };
  let token: Awaited<ReturnType<typeof getAccessToken>>;
  try {
    token = await getAccessToken(db, deps, intent.connectionId, intent.now);
  } catch (err) {
    log.error({ attemptId: intent.attempt.id, refundId: intent.refundId, err }, 'a stale refund intent could not be checked: no token');
    return { kind: 'unavailable' };
  }
  if (token.kind !== 'token') return { kind: 'unavailable' };
  const found = await unheldRefund(db, deps, token.accessToken, intent);
  switch (found.kind) {
    case 'found': {
      const stored = await storeAnswer(db, intent, found.refund);
      return stored.kind === 'requested' && stored.refundStatus === 'refunded' ? { kind: 'unchanged' } : stored;
    }
    case 'none':
      await withdraw(db, intent);
      return 'withdrawn';
    case 'failed':
      return { kind: 'unavailable' };
    default: {
      const unhandled: never = found;
      throw new Error(`unhandled reconcile: ${String(unhandled)}`);
    }
  }
}

type Unheld = { kind: 'found'; refund: MollieRefundView } | { kind: 'none' } | { kind: 'failed' };

/**
 * The refund Mollie lists on the attempt's payment that no `ProcessorRefund`
 * row holds, for the attempt's amount and currency — one
 * `refundEndedAtMollie` does not hold for when there is one, since an ended refund may be an
 * earlier one made in Mollie's dashboard. `failed`, logged with the intent's
 * ids, when Mollie cannot be asked.
 */
async function unheldRefund(db: PrismaClient, deps: MollieDeps, accessToken: string, intent: Held): Promise<Unheld> {
  const { attempt } = intent;
  let refunds: MollieRefundView[];
  try {
    const view = await deps.client.getPayment(accessToken, attempt.processorPaymentId, { testmode: attempt.testmode });
    if (view === null) throw new Error('Mollie no longer knows the payment');
    refunds = view.refunds;
  } catch (err) {
    log.error(
      { attemptId: attempt.id, refundId: intent.refundId, err },
      'a refund intent could not be checked against Mollie; it is kept until a sync or a new request settles it',
    );
    return { kind: 'failed' };
  }
  const held = await db.processorRefund.findMany({
    where: { processorRefundId: { in: refunds.map((r) => r.id) } },
    select: { processorRefundId: true },
  });
  const heldIds = new Set(held.map((r) => r.processorRefundId));
  const matching = refunds.filter((r) => !heldIds.has(r.id) && refundMatches(r, attempt.amount, attempt.currency));
  const refund = matching.find((r) => !(isRefundStatus(r.status) && refundEndedAtMollie(r.status))) ?? matching[0];
  return refund === undefined ? { kind: 'none' } : { kind: 'found', refund };
}

/**
 * Stores a refund Mollie accepted, or that this call adopted, on the intent
 * row, in one transaction under the payment's lock (the `TeacherStudent` link
 * first when an ask-again completes here): its outcome applies when Mollie
 * says `refunded`, and the teacher is told when it says `failed`. A row that
 * gained a Mollie id meanwhile, through a sync's adoption, is left as that
 * sync wrote it. A failure is logged with Mollie's refund id and rethrown.
 */
async function storeAnswer(db: PrismaClient, intent: Held, mollie: MollieRefundView): Promise<RefundResult> {
  const { attempt, refundId, outcome, paymentId, now } = intent;
  if (!isRefundStatus(mollie.status)) {
    log.warn({ attemptId: attempt.id, refundId: mollie.id, status: mollie.status }, 'Mollie reported a refund status fair.yoga does not know');
  }
  const refundStatus: ProcessorRefundStatus = isRefundStatus(mollie.status) ? mollie.status : 'queued';
  const { registration } = attempt.payment;
  const teacherId = registration.class.calendarEntry.teacherId;

  try {
    return await db.$transaction(async (tx): Promise<RefundResult> => {
      await setLockTimeout(tx);
      if (refundStatus === 'refunded' && outcome === 'reopened') {
        await lockTeacherStudentLink(tx, { teacherId, studentId: registration.studentId });
      }
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId} FOR UPDATE`;
      const row = await tx.processorRefund.findUnique({ where: { id: refundId }, select: { processorRefundId: true, status: true } });
      if (row === null) {
        log.error(
          { attemptId: attempt.id, refundId, mollieRefundId: mollie.id, refundStatus },
          'Mollie took a refund whose intent is gone; the teacher must reconcile its payment',
        );
        return { kind: 'requested', refundStatus, outcomeApplied: false };
      }
      if (row.processorRefundId !== null) return { kind: 'requested', refundStatus: row.status, outcomeApplied: false };
      const applied =
        refundStatus === 'refunded' && (await completeRefund(tx, { paymentId, attemptId: attempt.id, outcome, now })) === 'applied';
      if (refundStatus === 'failed') await notifyRefundFailed(tx, { teacherId, classId: registration.classId });
      await tx.processorRefund.update({ where: { id: refundId }, data: { processorRefundId: mollie.id, status: refundStatus } });
      return { kind: 'requested', refundStatus, outcomeApplied: applied };
    });
  } catch (err) {
    log.error(
      { attemptId: attempt.id, refundId, mollieRefundId: mollie.id, refundStatus, err },
      'Mollie took a refund fair.yoga could not record; a sync adopts it once the intent is old enough',
    );
    throw err;
  }
}
