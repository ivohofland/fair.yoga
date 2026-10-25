import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Currency, PaymentStatus, ProcessorPaymentStatus } from '@/lib/prisma-client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { Icon } from '@/components/ui/icon';
import { MethodChooser } from '@/components/student/method-chooser';
import { MarkSentControl } from '@/components/student/mark-sent-control';
import { PaymentBreakdown } from '@/components/student/payment-breakdown';
import { resolveReportedPaymentBreakdown } from '@/lib/payment-breakdown.server';
import { formatDayHeader, formatMoney } from '@/lib/format';
import { attemptProcessing, isClaimStanding, studentPaymentStateText } from '@/lib/payment-claim';
import { log } from '@/lib/log';
import { chargeNoteFor } from '@/lib/charge-note';
import { markedPaidLine, offersSentClaim, reportMissingPayment, sentClaimLine } from '@/lib/pay-page.server';
import {
  PAYMENTS_PAUSED_COPY,
  paymentMethodsForTeacher,
  paymentReference,
  type PaymentMethodsAnswer,
} from '@/lib/payment-methods';
import { isOutstanding } from '@/lib/payment-status';
import { payPageMethods, payPageTeacherSelect } from '@/services/pay-page-methods';
import { mollieDeps } from '@/services/mollie-deps';

export const dynamic = 'force-dynamic';

/**
 * What the student is told on coming back from Mollie, from the attempt's
 * status as last synced; nothing for one still `open`. Only a paid attempt
 * speaks once the payment is settled, since the others point at the rows a
 * settled payment no longer shows.
 */
function attemptBanner(status: ProcessorPaymentStatus, outstanding: boolean): string | null {
  switch (status) {
    case 'paid':
      return 'Paid — thank you.';
    case 'pending':
    case 'authorized':
      return outstanding ? 'Processing — we’ll let you know.' : null;
    case 'canceled':
    case 'expired':
    case 'failed':
      return outstanding ? 'That payment didn’t go through. You can try again below.' : null;
    case 'open':
      return null;
    default: {
      // A status added to `ProcessorPaymentStatus` without a banner fails the build here.
      const unhandled: never = status;
      log.error({ status: String(unhandled) }, 'pay page: unhandled attempt status');
      return null;
    }
  }
}

// One class's payment for the signed-in student: how to pay it, or that it
// is settled. `?attempt=` names the Mollie attempt the student just came back
// from.
export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ classId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session?.studentId) redirectNonStudent(session);
  const { classId } = await params;
  const { attempt: attemptParam } = await searchParams;

  // Keyed by the session's own student: another student's class finds no
  // row, and answers exactly as a class that does not exist.
  const registration = await prisma.registration.findUnique({
    where: { classId_studentId: { classId, studentId: session.studentId } },
    include: {
      payment: { include: { processorAttempts: { select: { id: true, status: true } } } },
      class: {
        include: {
          calendarEntry: {
            include: {
              teacher: {
                select: {
                  firstName: true,
                  lastName: true,
                  defaultTimezone: true,
                  // Includes every bank account: the one in the class's currency is picked
                  // below, since this query cannot filter on a sibling column.
                  ...payPageTeacherSelect,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!registration) notFound();
  const payment = registration.payment;
  if (!payment) {
    reportMissingPayment({
      classId: registration.class.id,
      registrationId: registration.id,
      registrationStatus: registration.status,
      classStatus: registration.class.status,
      pricingMode: registration.class.pricingMode,
    });
    notFound();
  }

  const cls = registration.class;
  const entry = cls.calendarEntry;
  const teacher = entry.teacher;
  const amount = Number(payment.amount);
  const reference = paymentReference(entry);
  // Only an outstanding payment shows its methods, so only it asks Mollie.
  const methods = isOutstanding(payment.status)
    ? await payPageMethods(prisma, mollieDeps(), teacher, cls.currency, payment.amount)
    : paymentMethodsForTeacher(teacher, cls.currency);
  // A Mollie payment on its way reads as the claim does: the money is moving.
  const state =
    attemptProcessing(payment) && !isClaimStanding(payment)
      ? { label: 'Processing', className: 'text-brown' }
      : studentPaymentStateText(payment);
  const returnedFrom =
    typeof attemptParam === 'string' ? payment.processorAttempts.find((a) => a.id === attemptParam) : undefined;
  const banner = returnedFrom === undefined ? null : attemptBanner(returnedFrom.status, isOutstanding(payment.status));
  // A waived payment is not charged, so it gets no line saying it still is.
  const chargeNote = payment.status === 'not_charged' ? null : chargeNoteFor(registration.status);
  const breakdown = resolveReportedPaymentBreakdown(
    {
      classStatus: cls.status,
      pricingMode: cls.pricingMode,
      roomCost: cls.roomCost,
      totalRevenue: cls.totalRevenue,
      vatTotal: cls.vatTotal,
      vatPercent: Number(cls.vatPercent),
      totalStudents: cls.totalStudents,
      payment,
    },
    { classId: cls.id, registrationId: registration.id },
  );

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-title">{entry.classType}</h1>
      <p className="type-caption mb-4">
        {`${formatDayHeader(entry.date)} · with ${teacher.firstName} ${teacher.lastName}`}
      </p>
      <div className="mb-6">
        <div className="flex items-baseline justify-between gap-3">
          <p className={`type-number ${isOutstanding(payment.status) ? 'text-brown' : ''}`}>{formatMoney(amount, cls.currency)}</p>
          <p className={`type-caption ${state.className}`}>{state.label}</p>
        </div>
        {chargeNote !== null && <p className="type-caption mt-1">{chargeNote}</p>}
      </div>
      {banner !== null && (
        <p role="status" data-testid="attempt-banner" className="type-body mb-6 bg-sand-soft border border-border rounded-card p-4">
          {banner}
        </p>
      )}
      <PayBody
        status={payment.status}
        methods={methods}
        amount={amount}
        currency={cls.currency}
        reference={reference}
        teacherFirstName={teacher.firstName}
        paymentId={payment.id}
        paidAt={payment.paidAt}
        paidMethod={payment.method}
        reportedAt={payment.studentReportedAt}
        timeZone={teacher.defaultTimezone}
      />
      {breakdown.kind === 'shown' && (
        <PaymentBreakdown lines={breakdown.lines} format={cls.format} classType={entry.classType} date={entry.date} currency={cls.currency} />
      )}
    </div>
  );
}

function PayBody({
  status,
  methods,
  amount,
  currency,
  reference,
  teacherFirstName,
  paymentId,
  paidAt,
  paidMethod,
  reportedAt,
  timeZone,
}: {
  status: PaymentStatus;
  methods: PaymentMethodsAnswer;
  amount: number;
  currency: Currency;
  reference: string;
  teacherFirstName: string;
  paymentId: string;
  paidAt: Date | null;
  paidMethod: string | null;
  reportedAt: Date | null;
  timeZone: string;
}) {
  const sentControl = (
    <MarkSentControl
      paymentId={paymentId}
      claimedLine={reportedAt === null ? null : sentClaimLine(reportedAt, timeZone)}
    />
  );
  switch (status) {
    case 'paid':
      return <p className="type-body mb-6">{markedPaidLine(paidAt, paidMethod, timeZone, paymentId)}</p>;
    case 'not_charged':
      return <p className="type-body mb-6">{`${teacherFirstName} isn’t charging for this class.`}</p>;
    case 'pending':
    case 'overdue':
      // Paused is not zero methods: zero methods says pay directly, the
      // opposite of holding off.
      if (methods.kind === 'paused') {
        return <p className="type-body mb-6">{PAYMENTS_PAUSED_COPY}</p>;
      }
      if (methods.methods.length === 0) {
        return (
          <>
            <p className="type-body mb-6">
              {`Pay ${teacherFirstName} directly — cash or transfer, whatever you two agreed. They’ll mark it as received.`}
            </p>
            {sentControl}
          </>
        );
      }
      return (
        <>
          <section className="mb-6">
            <h2 className="type-subtitle mb-3">How would you like to pay?</h2>
            <MethodChooser
              name="pay-method"
              methods={methods.methods}
              amount={{ kind: 'fixed', amount }}
              currency={currency}
              reference={reference}
              paymentId={paymentId}
            />
          </section>
          {offersSentClaim(methods.methods, reportedAt) && sentControl}
        </>
      );
    default: {
      // A status added to `PaymentStatus` without a body fails the build here.
      const unhandled: never = status;
      log.error({ status: String(unhandled) }, 'pay page: unhandled payment status');
      return null;
    }
  }
}
