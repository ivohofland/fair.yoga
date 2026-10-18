import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@/lib/prisma-client';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import { logDegraded } from '@/lib/degradation';
import { MollieUnavailable, type MolliePaymentView } from '@/lib/mollie/client';
import { PAYMENTS_PAUSED_COPY, paymentReference } from '@/lib/payment-methods';
import { isOutstanding } from '@/lib/payment-status';
import { livePayoutIdentity, takesMolliePayments } from '@/lib/processor-liveness';
import { isAllowedMollieMethod, MOLLIE_METHODS, type AllowedMollieMethod } from '@/lib/processor-methods';
import type { MollieDeps } from './mollie-deps';
import { listOfferedMethods } from './processor-methods-offer';
import { getAccessToken } from './processor-token';

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
