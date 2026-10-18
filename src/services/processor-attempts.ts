import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  Prisma,
  ProcessorPaymentStatus,
  type ProcessorRefundStatus,
  type PaymentStatus,
  type PrismaClient,
  type RefundOutcome,
} from '@/lib/prisma-client';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { lockTeacherForNoKeyUpdate, setLockTimeout } from '@/lib/db-locks';
import { logDegraded } from '@/lib/degradation';
import { formatMoney } from '@/lib/format';
import { log } from '@/lib/log';
import { MollieUnavailable, type MollieAmount, type MolliePaymentView } from '@/lib/mollie/client';
import { PAYMENTS_PAUSED_COPY, paymentReference } from '@/lib/payment-methods';
import { isOutstanding } from '@/lib/payment-status';
import { livePayoutIdentity, takesMolliePayments } from '@/lib/processor-liveness';
import { isRefundStatus, refundIsFinal } from '@/lib/processor-refund-status';
import { isAllowedMollieMethod, mollieMethodLabel, MOLLIE_METHODS, type AllowedMollieMethod } from '@/lib/processor-methods';
import type { MollieDeps } from './mollie-deps';
import { listOfferedMethods } from './processor-methods-offer';
import { getAccessToken } from './processor-token';
import { createNotification } from './notifications';
import { markPaymentPaid, reopenInTransaction } from './payments';
import { lockTeacherStudentLink } from './roster-link';
import { adoptionFor } from './refund-adoption';

export type AttemptRefusal = Extract<
  CodedRefusal,
  { code: 'NOT_FOUND' | 'PAYMENT_SETTLED' | 'PAYMENTS_PAUSED' | 'PROCESSOR_NOT_CONNECTED' | 'PROCESSOR_METHOD_UNAVAILABLE' }
>;

export type CreateAttemptOutcome =
  | { kind: 'checkout'; attemptId: string; checkoutUrl: string }
  | { kind: 'refused'; refusal: AttemptRefusal }
  | { kind: 'unavailable' };

/** The connection columns `takesMolliePayments` reads, and the row's id. */
const LIVENESS_SELECT = {
  id: true, organizationId: true, profileId: true, disconnectedAt: true, scopes: true,
} as const satisfies Prisma.ProcessorConnectionSelect;

/** An open attempt is reused only while it has more than this long left. */
const REUSE_MARGIN_MS = 60_000;

const NOT_FOUND: AttemptRefusal = codedRefusal('NOT_FOUND', 'This payment no longer exists.');
const SETTLED: AttemptRefusal = codedRefusal('PAYMENT_SETTLED', 'This payment is already settled, so there’s nothing to pay.');
const PAUSED: AttemptRefusal = codedRefusal('PAYMENTS_PAUSED', PAYMENTS_PAUSED_COPY);
const NOT_CONNECTED: AttemptRefusal = codedRefusal(
  'PROCESSOR_NOT_CONNECTED',
  'Paying online isn’t available for this payment any more. Choose another way to pay.',
);

function methodUnavailable(label: string): AttemptRefusal {
  return codedRefusal('PROCESSOR_METHOD_UNAVAILABLE', `${label} isn’t available for this payment. Choose another way to pay.`);
}

/** Where Mollie sends the student back after checkout. */
export function processorReturnUrl(appUrl: string, paymentId: string, attemptId: string): string {
  return `${appUrl}/api/payments/${encodeURIComponent(paymentId)}/processor-return?attempt=${encodeURIComponent(attemptId)}`;
}

/** The hosts that name this machine, which Mollie cannot reach. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** Where Mollie reports a payment's status changes, or null on a host in `LOCAL_HOSTS`. */
export function processorWebhookUrl(appUrl: string): string | null {
  return LOCAL_HOSTS.has(new URL(appUrl).hostname) ? null : `${appUrl}/api/webhooks/mollie`;
}

/** Mollie's expiry for the payment, or the method's own window from `now` when Mollie gave none. */
function expiryOf(view: MolliePaymentView, method: AllowedMollieMethod, now: Date): Date {
  const stated = view.expiresAt === null ? Number.NaN : Date.parse(view.expiresAt);
  return Number.isNaN(stated) ? new Date(now.getTime() + MOLLIE_METHODS[method].expiresMinutes * 60_000) : new Date(stated);
}

/**
 * Starts the student's Mollie payment for one of their own payments, or
 * reuses an open attempt for the same method, made under the connection's
 * current profile and mode, that has more than a minute left. Every Mollie
 * call runs before its transaction opens. The attempt row is written after `createPayment` answers, in that transaction, which
 * takes the teacher's lock first and re-checks the payment, the pause and the
 * connection under it; so when `createPayment`'s answer is lost no row is
 * written and the student is given no checkout URL. A connection that stopped
 * taking payments while Mollie was called is refused with nothing written,
 * and the Mollie payment it started expires unpaid.
 */
export async function createAttempt(
  db: PrismaClient,
  deps: MollieDeps | null,
  input: { paymentId: string; studentId: string; method: string; now?: Date },
): Promise<CreateAttemptOutcome> {
  const now = input.now ?? new Date();
  const payment = await db.payment.findFirst({
    where: { id: input.paymentId, registration: { studentId: input.studentId } },
    select: {
      id: true,
      status: true,
      amount: true,
      registration: {
        select: {
          class: {
            select: {
              currency: true,
              calendarEntry: {
                select: {
                  classType: true,
                  date: true,
                  teacherId: true,
                  teacher: {
                    select: {
                      paymentsPausedAt: true,
                      processorConnection: { select: { ...LIVENESS_SELECT, testmode: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (payment === null) return refused(NOT_FOUND);
  if (!isOutstanding(payment.status)) return refused(SETTLED);
  const { currency, calendarEntry: entry } = payment.registration.class;
  if (entry.teacher.paymentsPausedAt !== null) return refused(PAUSED);
  const connection = entry.teacher.processorConnection;
  const identity = takesMolliePayments(connection) ? livePayoutIdentity(connection) : null;
  if (connection === null || identity === null) return refused(NOT_CONNECTED);
  if (deps === null) return { kind: 'unavailable' };
  const method = input.method;
  if (!isAllowedMollieMethod(method)) return refused(methodUnavailable('That payment method'));

  const reusable = await db.processorPayment.findFirst({
    where: {
      paymentId: payment.id,
      connectionId: connection.id,
      profileId: identity.profileId,
      testmode: connection.testmode,
      method,
      status: 'open',
      checkoutUrl: { not: null },
      expiresAt: { gt: new Date(now.getTime() + REUSE_MARGIN_MS) },
    },
    orderBy: { expiresAt: 'desc' },
    select: { id: true, checkoutUrl: true },
  });
  if (reusable?.checkoutUrl) return { kind: 'checkout', attemptId: reusable.id, checkoutUrl: reusable.checkoutUrl };

  const offer = await listOfferedMethods(
    db,
    deps,
    { id: connection.id, profileId: identity.profileId, testmode: connection.testmode },
    payment.amount,
    currency,
  );
  if (offer.kind === 'unavailable') return { kind: 'unavailable' };
  if (!offer.offered.includes(method)) return refused(methodUnavailable(MOLLIE_METHODS[method].label));

  const token = await getAccessToken(db, deps, connection.id, now);
  if (token.kind === 'disconnected') return refused(NOT_CONNECTED);
  if (token.kind === 'unavailable') return { kind: 'unavailable' };

  const attemptId = randomUUID();
  let view: MolliePaymentView;
  try {
    view = await deps.client.createPayment(token.accessToken, {
      amount: { value: payment.amount.toFixed(2), currency },
      description: paymentReference(entry),
      method,
      redirectUrl: processorReturnUrl(deps.config.appUrl, payment.id, attemptId),
      webhookUrl: processorWebhookUrl(deps.config.appUrl),
      profileId: identity.profileId,
      metadata: { paymentId: payment.id, attemptId },
      testmode: connection.testmode,
    });
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    logDegraded(
      'MOLLIE_UNAVAILABLE',
      { connectionId: connection.id, operation: 'createPayment', ...(err.status === null ? {} : { status: err.status }) },
      'Mollie could not start a payment; the student was shown no checkout',
      err,
    );
    return { kind: 'unavailable' };
  }
  const checkoutUrl = view.checkoutUrl;
  if (checkoutUrl === null) {
    logDegraded(
      'MOLLIE_UNAVAILABLE',
      { connectionId: connection.id, operation: 'createPayment' },
      'Mollie started a payment without a checkout URL; the student was shown no checkout',
    );
    return { kind: 'unavailable' };
  }
  const expiresAt = expiryOf(view, method, now);

  return db.$transaction(async (tx): Promise<CreateAttemptOutcome> => {
    // The teacher first, as `disconnect` takes it: a disconnect has either
    // committed before the read below, or waits and then counts this attempt.
    if ((await lockTeacherForNoKeyUpdate(tx, entry.teacherId)) === null) return refused(NOT_CONNECTED);
    const current = await tx.payment.findUnique({
      where: { id: payment.id },
      select: {
        status: true,
        registration: {
          select: {
            class: {
              select: {
                calendarEntry: {
                  select: {
                    teacher: {
                      select: { paymentsPausedAt: true, processorConnection: { select: LIVENESS_SELECT } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (current === null) return refused(NOT_FOUND);
    if (!isOutstanding(current.status)) return refused(SETTLED);
    const teacher = current.registration.class.calendarEntry.teacher;
    if (teacher.paymentsPausedAt !== null) return refused(PAUSED);
    const row = teacher.processorConnection;
    if (row === null || row.id !== connection.id || !takesMolliePayments(row)) return refused(NOT_CONNECTED);

    await tx.processorPayment.create({
      data: {
        id: attemptId,
        paymentId: payment.id,
        connectionId: connection.id,
        processorPaymentId: view.id,
        profileId: identity.profileId,
        testmode: connection.testmode,
        method,
        status: 'open',
        amount: payment.amount,
        currency,
        checkoutUrl,
        expiresAt,
      },
    });
    return { kind: 'checkout', attemptId, checkoutUrl };
  });
}

function refused(refusal: AttemptRefusal): CreateAttemptOutcome {
  return { kind: 'refused', refusal };
}

// ---------------------------------------------------------------------------
// Settling: what Mollie reports about an attempt, applied
// ---------------------------------------------------------------------------

/** What a sync did to the attempt. `unknown`: no attempt we can ask Mollie about, or an answer we cannot read. */
export type SyncResult = 'settled' | 'unchanged' | 'paid_twice' | 'charged_back' | 'status_only' | 'unknown';

/** The writes `decideSync` asks for; `result` is what the sync answers. */
export type SyncDecision = {
  attemptStatus: ProcessorPaymentStatus;
  settle: boolean;
  notifyPaidTwice: boolean;
  recordChargeback: boolean;
  result: SyncResult;
};

/**
 * Spec §5's table: what one fetched attempt status does, given the attempt
 * and payment as they stand under the payment's row lock. A chargeback is
 * decided first. A `paid` attempt is never moved again: its repeat, its
 * duplicate already told, and one a refund or chargeback has released all
 * answer `unchanged`, so none can settle the payment a second time.
 */
export function decideSync(input: {
  mollieStatus: ProcessorPaymentStatus;
  previousStatus: ProcessorPaymentStatus;
  paymentStatus: PaymentStatus;
  settledByThis: boolean;
  chargedBack: boolean;
  alreadyChargedBack: boolean;
}): SyncDecision {
  const write = (over: Partial<SyncDecision> & Pick<SyncDecision, 'attemptStatus' | 'result'>): SyncDecision => ({
    settle: false, notifyPaidTwice: false, recordChargeback: false, ...over,
  });
  const unchanged = (attemptStatus: ProcessorPaymentStatus) => write({ attemptStatus, result: 'unchanged' });

  if (input.mollieStatus === 'paid' && input.chargedBack) {
    return input.alreadyChargedBack
      ? unchanged('paid')
      : write({ attemptStatus: 'paid', recordChargeback: true, result: 'charged_back' });
  }
  if (input.previousStatus === 'paid') return unchanged('paid');
  if (input.mollieStatus === input.previousStatus) return unchanged(input.previousStatus);
  if (input.mollieStatus !== 'paid') return write({ attemptStatus: input.mollieStatus, result: 'status_only' });
  switch (input.paymentStatus) {
    case 'pending':
    case 'overdue':
      return write({ attemptStatus: 'paid', settle: true, result: 'settled' });
    case 'paid':
      return input.settledByThis ? unchanged('paid') : write({ attemptStatus: 'paid', notifyPaidTwice: true, result: 'paid_twice' });
    case 'not_charged':
      return write({ attemptStatus: 'paid', notifyPaidTwice: true, result: 'paid_twice' });
    default: {
      const unhandled: never = input.paymentStatus;
      throw new Error(`unhandled payment status: ${String(unhandled)}`);
    }
  }
}

/** What one fetched refund status does to the stored `ProcessorRefund` row. */
export type RefundSyncDecision =
  | { kind: 'unchanged' }
  | { kind: 'status'; status: ProcessorRefundStatus; complete: boolean; notifyFailed: boolean };

/** A row newly `refunded` completes; one newly `failed` tells the teacher; a row `refundIsFinal` holds for stays put. */
export function decideRefundSync(input: { storedStatus: ProcessorRefundStatus; mollieStatus: ProcessorRefundStatus }): RefundSyncDecision {
  if (input.storedStatus === input.mollieStatus || refundIsFinal(input.storedStatus)) return { kind: 'unchanged' };
  return {
    kind: 'status',
    status: input.mollieStatus,
    complete: input.mollieStatus === 'refunded',
    notifyFailed: input.mollieStatus === 'failed',
  };
}

/** What `completeRefund` did with the refund's outcome. `missed`: the payment was no longer `paid`. */
export type CompletionResult = 'applied' | 'missed' | 'no_outcome';

/**
 * Applies a completed refund's outcome, in the caller's transaction, and
 * tells the student their money is on its way back. `waived` moves the
 * payment `paid → not_charged` (Decision 9) by a compare-and-swap on `paid`,
 * clearing the paid fields as a waived row carries none;
 * `reopened` asks again through `reopenInTransaction`, which swaps on its own
 * settled states. Either releases the attempt when it applies; a miss applies
 * nothing and is logged. A null outcome (a duplicate's refund) changes no
 * payment. The student is told whatever the result, because the money went
 * back.
 *
 * With outcome `reopened` the caller's transaction must not have locked the
 * payment before the `TeacherStudent` link (`docs/lock-order.md`).
 */
export async function completeRefund(
  tx: Prisma.TransactionClient,
  input: { paymentId: string; attemptId: string; outcome: RefundOutcome | null; now: Date },
): Promise<CompletionResult> {
  const { paymentId, attemptId, outcome } = input;
  const result = await applyRefundOutcome(tx, input);
  if (result === 'missed') {
    log.warn({ paymentId, attemptId, outcome }, 'a completed refund found its payment no longer paid; its outcome was not applied');
  }
  const attempt = await tx.processorPayment.findUniqueOrThrow({
    where: { id: attemptId },
    select: {
      amount: true,
      currency: true,
      payment: {
        select: {
          registration: {
            select: { studentId: true, classId: true, class: { select: { calendarEntry: { select: { teacher: { select: { firstName: true } } } } } } },
          },
        },
      },
    },
  });
  const { registration } = attempt.payment;
  await createNotification(tx, {
    recipientType: 'student',
    recipientId: registration.studentId,
    type: 'payment_refunded',
    title: 'Payment refunded',
    body: `${registration.class.calendarEntry.teacher.firstName} refunded ${formatMoney(attempt.amount, attempt.currency)}. It goes back the way you paid.`,
    relatedClassId: registration.classId,
  });
  return result;
}

async function applyRefundOutcome(
  tx: Prisma.TransactionClient,
  { paymentId, attemptId, outcome, now }: { paymentId: string; attemptId: string; outcome: RefundOutcome | null; now: Date },
): Promise<CompletionResult> {
  switch (outcome) {
    case null:
      return 'no_outcome';
    case 'reopened': {
      const reopened = await reopenInTransaction(tx, paymentId, { refundAttemptId: attemptId });
      return reopened.kind === 'applied' ? 'applied' : 'missed';
    }
    case 'waived': {
      const { count } = await tx.payment.updateMany({
        where: { id: paymentId, status: 'paid' },
        data: { status: 'not_charged', notChargedAt: now, studentReportedAt: null, method: null, paidAt: null },
      });
      if (count === 0) return 'missed';
      await tx.processorPayment.updateMany({ where: { id: attemptId, paymentId }, data: { settledPayment: false } });
      return 'applied';
    }
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled refund outcome: ${String(unhandled)}`);
    }
  }
}

/** Tells the teacher a refund of a payment in this class did not go through. */
export async function notifyRefundFailed(tx: Prisma.TransactionClient, { teacherId, classId }: { teacherId: string; classId: string }): Promise<void> {
  await createNotification(tx, {
    recipientType: 'teacher',
    recipientId: teacherId,
    type: 'refund_failed',
    title: 'Refund failed',
    body: 'A refund didn’t go through. Check your Mollie balance and try again from the payment.',
    relatedClassId: classId,
  });
}

const paymentStatusSchema = z.enum(ProcessorPaymentStatus);

/** The attempt columns a sync reads before it calls Mollie. */
const SYNC_ATTEMPT_SELECT = {
  id: true,
  paymentId: true,
  connectionId: true,
  profileId: true,
  testmode: true,
  currency: true,
  payment: {
    select: {
      registration: {
        select: {
          studentId: true,
          classId: true,
          student: { select: { firstName: true } },
          class: { select: { calendarEntry: { select: { teacherId: true } } } },
        },
      },
    },
  },
} as const satisfies Prisma.ProcessorPaymentSelect;

/**
 * Fetches one attempt from Mollie and applies what Mollie says, as spec §5
 * describes: the attempt's status, a settle, a double payment, a chargeback,
 * and every refund on it fair.yoga made. `processorPaymentId` is Mollie's id
 * for the attempt. Mollie's answer is the only thing believed, and it is
 * fetched with the token of the attempt's own connection, in the mode the
 * attempt was made in.
 *
 * A refund no row holds is adopted into this attempt's refund intent still
 * awaiting its Mollie id when `adoptionFor` says so, and then applied like
 * any other row; one it says to `ignore` was made in Mollie's own dashboard.
 *
 * The Mollie call runs before the transaction opens. The transaction locks
 * the payment's row (`FOR UPDATE`), and before it the `TeacherStudent` link
 * when a refund with outcome `reopened` may complete, decided from the
 * fetched view and the stored rows (`docs/lock-order.md`). A refund it cannot
 * apply yet is left unwritten and the sync answers `unavailable`, so Mollie
 * retries; every other write in the transaction commits.
 */
export async function syncAttempt(
  db: PrismaClient,
  deps: MollieDeps | null,
  processorPaymentId: string,
): Promise<SyncResult | 'unavailable'> {
  const attempt = await db.processorPayment.findUnique({ where: { processorPaymentId }, select: SYNC_ATTEMPT_SELECT });
  if (attempt === null || attempt.connectionId === null) return 'unknown';
  if (deps === null) return 'unavailable';
  const connectionId = attempt.connectionId;
  const now = new Date();

  const token = await getAccessToken(db, deps, connectionId, now);
  if (token.kind === 'disconnected') {
    log.warn({ attemptId: attempt.id, connectionId }, 'a Mollie attempt could not be synced: its connection was revoked');
    return 'unknown';
  }
  if (token.kind === 'unavailable') return 'unavailable';

  let view: MolliePaymentView | null;
  try {
    view = await deps.client.getPayment(token.accessToken, processorPaymentId, { testmode: attempt.testmode });
  } catch (err) {
    if (!(err instanceof MollieUnavailable)) throw err;
    logDegraded(
      'MOLLIE_UNAVAILABLE',
      { connectionId, operation: 'getPayment', ...(err.status === null ? {} : { status: err.status }) },
      'Mollie could not report a payment; the sync was answered 503 for Mollie to retry',
      err,
    );
    return 'unavailable';
  }
  if (view === null) {
    log.warn(
      { attemptId: attempt.id, processorPaymentId, profileId: attempt.profileId },
      'Mollie no longer knows an attempt fair.yoga holds; the teacher must reconcile its payment',
    );
    return 'unknown';
  }
  const mollieStatus = paymentStatusSchema.safeParse(view.status);
  if (!mollieStatus.success) {
    log.warn({ attemptId: attempt.id, status: view.status }, 'Mollie reported a payment status fair.yoga does not know');
    return 'unknown';
  }

  const refunds: { id: string; status: ProcessorRefundStatus; amount: MollieAmount }[] = [];
  for (const refund of view.refunds) {
    const status = refund.status;
    if (isRefundStatus(status)) refunds.push({ id: refund.id, status, amount: refund.amount });
    else log.warn({ attemptId: attempt.id, refundId: refund.id, status: refund.status }, 'Mollie reported a refund status fair.yoga does not know');
  }

  // Whether a refund with outcome `reopened` may complete here, read from the
  // stored rows before any lock: such a sync takes the link lock first. A
  // refund no row holds counts by the awaiting row it would be adopted into.
  const stored = await db.processorRefund.findMany({
    where: { attemptId: attempt.id },
    select: { id: true, processorRefundId: true, status: true, outcome: true, amount: true, requestedAt: true },
  });
  const awaitingBefore = stored.filter((s) => s.processorRefundId === null);
  const takesLinkLock = refunds.some((r) => {
    const held = stored.find((s) => s.processorRefundId === r.id);
    const adoption = held === undefined ? adoptionFor(awaitingBefore, r, attempt.currency, now) : null;
    const row = held ?? (adoption?.kind === 'adopt' ? adoption.row : undefined);
    return row !== undefined && row.outcome === 'reopened' && completes(decideRefundSync({ storedStatus: row.status, mollieStatus: r.status }));
  });

  const chargedBack = view.amountChargedBack !== null && new Prisma.Decimal(view.amountChargedBack.value).greaterThan(0);
  const { registration } = attempt.payment;
  const teacherId = registration.class.calendarEntry.teacherId;

  const outcome = await db.$transaction(async (tx): Promise<{ result: SyncResult; deferred: string[] }> => {
    await setLockTimeout(tx);
    if (takesLinkLock) await lockTeacherStudentLink(tx, { teacherId, studentId: registration.studentId });
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${attempt.paymentId} FOR UPDATE`;

    const current = await tx.processorPayment.findUnique({
      where: { id: attempt.id },
      select: { status: true, method: true, paidAt: true, settledPayment: true, chargedBackAt: true, amount: true, currency: true },
    });
    const payment = await tx.payment.findUnique({ where: { id: attempt.paymentId }, select: { status: true } });
    if (current === null || payment === null) return { result: 'unknown', deferred: [] };

    const decision = decideSync({
      mollieStatus: mollieStatus.data,
      previousStatus: current.status,
      paymentStatus: payment.status,
      settledByThis: current.settledPayment,
      chargedBack,
      alreadyChargedBack: current.chargedBackAt !== null,
    });
    let result = decision.result;
    const amount = formatMoney(current.amount, current.currency);
    const method = view.method ?? current.method;
    const chargedBackAmount =
      view.amountChargedBack === null ? amount : formatMoney(new Prisma.Decimal(view.amountChargedBack.value), current.currency);

    if (result !== 'unchanged') {
      await tx.processorPayment.update({
        where: { id: attempt.id },
        data: {
          status: decision.attemptStatus,
          ...(view.method === null ? {} : { method: view.method }),
          ...(decision.attemptStatus === 'paid' && current.paidAt === null ? { paidAt: paidAtOf(view, now) } : {}),
          ...(decision.recordChargeback ? { chargedBackAt: now, settledPayment: false } : {}),
        },
      });
    }
    if (decision.recordChargeback) {
      await createNotification(tx, {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'payment_charged_back',
        title: 'Payment disputed',
        body:
          `${registration.student.firstName} disputed ${chargedBackAmount} with their bank and it was taken back.` +
          (current.settledPayment ? ' You can mark the payment unpaid to ask again.' : ''),
        relatedClassId: registration.classId,
      });
    }
    let notifyPaidTwice = decision.notifyPaidTwice;
    if (decision.settle) {
      const marked = await markPaymentPaid(tx, attempt.paymentId, 'mollie');
      if (marked.kind === 'applied') {
        await tx.processorPayment.update({ where: { id: attempt.id }, data: { settledPayment: true } });
      } else {
        result = 'paid_twice';
        notifyPaidTwice = true;
      }
    }
    if (notifyPaidTwice) {
      await createNotification(tx, {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'payment_paid_twice',
        title: 'Paid twice',
        body: `${registration.student.firstName} also paid ${amount} by ${mollieMethodLabel(method)}. You can refund it from the payment.`,
        relatedClassId: registration.classId,
      });
    }

    const deferred: string[] = [];
    for (const refund of refunds) {
      const held = await tx.processorRefund.findUnique({
        where: { processorRefundId: refund.id },
        select: { id: true, attemptId: true, status: true, outcome: true },
      });
      if (held !== null && held.attemptId !== attempt.id) continue;
      let row = held;
      let adopting = false;
      if (row === null) {
        // No row holds this refund: adopt it into an intent of this attempt's
        // still awaiting its Mollie id, wait for that intent's own call, or,
        // with neither, leave it as a refund made in Mollie's own dashboard.
        const awaiting = await tx.processorRefund.findMany({
          where: { attemptId: attempt.id, processorRefundId: null },
          select: { id: true, attemptId: true, status: true, outcome: true, amount: true, requestedAt: true },
        });
        const adoption = adoptionFor(awaiting, refund, current.currency, now);
        if (adoption.kind === 'ignore') continue;
        if (adoption.kind === 'defer') {
          deferred.push(refund.id);
          continue;
        }
        row = adoption.row;
        adopting = true;
      }
      const step = decideRefundSync({ storedStatus: row.status, mollieStatus: refund.status });
      if (step.kind === 'status' && step.complete && row.outcome === 'reopened' && !takesLinkLock) {
        // Completing it would take the link lock after the payment's.
        deferred.push(refund.id);
        continue;
      }
      if (adopting) {
        const claimed = await tx.processorRefund.updateMany({
          where: { id: row.id, processorRefundId: null },
          data: { processorRefundId: refund.id },
        });
        if (claimed.count === 0) continue;
        log.info({ attemptId: attempt.id, refundId: row.id, mollieRefundId: refund.id }, 'a Mollie refund was adopted into the intent that never stored its id');
      }
      if (step.kind === 'unchanged') continue;
      const moved = await tx.processorRefund.updateMany({ where: { id: row.id, status: row.status }, data: { status: step.status } });
      if (moved.count === 0) continue;
      if (step.complete) await completeRefund(tx, { paymentId: attempt.paymentId, attemptId: attempt.id, outcome: row.outcome, now });
      if (step.notifyFailed) await notifyRefundFailed(tx, { teacherId, classId: registration.classId });
    }
    return { result, deferred };
  });

  if (outcome.deferred.length > 0) {
    log.warn(
      { attemptId: attempt.id, deferred: true, refundIds: outcome.deferred },
      'a Mollie refund could not be applied yet; the sync was answered 503 for Mollie to retry',
    );
    return 'unavailable';
  }
  return outcome.result;
}

function completes(decision: RefundSyncDecision): boolean {
  return decision.kind === 'status' && decision.complete;
}

/** Mollie's `paidAt` when it parses, else `now`. */
function paidAtOf(view: MolliePaymentView, now: Date): Date {
  const stated = view.paidAt === null ? Number.NaN : Date.parse(view.paidAt);
  return Number.isNaN(stated) ? now : new Date(stated);
}
