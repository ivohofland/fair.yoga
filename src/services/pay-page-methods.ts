import type { Currency, Prisma, PrismaClient } from '@/lib/prisma-client';
import { paymentMethodsForTeacher, teacherPaymentSelect, type PaymentMethodsAnswer } from '@/lib/payment-methods';
import { livePayoutIdentity, takesMolliePayments } from '@/lib/processor-liveness';
import type { MollieDeps } from './mollie-deps';
import { listOfferedMethods } from './processor-methods-offer';

/** `teacherPaymentSelect` plus the connection columns that say whether Mollie rows may be offered. */
export const payPageTeacherSelect = {
  ...teacherPaymentSelect,
  processorConnection: {
    select: { id: true, organizationId: true, profileId: true, testmode: true, disconnectedAt: true, scopes: true },
  },
} as const satisfies Prisma.TeacherSelect;

export type PayPageTeacher = Prisma.TeacherGetPayload<{ select: typeof payPageTeacherSelect }>;

/**
 * The pay page's answer: `paymentMethodsForTeacher`'s, with the Mollie
 * methods the teacher offers for this amount and currency put first. Mollie
 * is asked only for a connection that may take payments; when it is not
 * configured, or cannot answer, the answer is `paymentMethodsForTeacher`'s
 * unchanged.
 */
export async function payPageMethods(
  db: PrismaClient,
  deps: MollieDeps | null,
  teacher: PayPageTeacher,
  currency: Currency,
  amount: Prisma.Decimal,
): Promise<PaymentMethodsAnswer> {
  const manual = paymentMethodsForTeacher(teacher, currency);
  if (manual.kind === 'paused' || deps === null) return manual;
  const connection = teacher.processorConnection;
  const identity = takesMolliePayments(connection) ? livePayoutIdentity(connection) : null;
  if (connection === null || identity === null) return manual;

  const offer = await listOfferedMethods(
    db,
    deps,
    { id: connection.id, profileId: identity.profileId, testmode: connection.testmode },
    amount,
    currency,
  );
  if (offer.kind === 'unavailable') return manual;
  return {
    kind: 'methods',
    methods: [...offer.offered.map((method) => ({ kind: 'processor' as const, method })), ...manual.methods],
  };
}
