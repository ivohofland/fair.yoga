import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Currency, PaymentStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { Icon } from '@/components/ui/icon';
import { PaymentDetails } from '@/components/student/payment-details';
import { PaymentQr } from '@/components/student/payment-qr';
import { PaymentBreakdown } from '@/components/student/payment-breakdown';
import { resolveReportedPaymentBreakdown } from '@/lib/payment-breakdown.server';
import { formatDayHeader, formatMoney, paymentStateText } from '@/lib/format';
import { log } from '@/lib/log';
import { chargeNoteFor } from '@/lib/charge-note';
import { markedPaidLine, reportMissingPayment } from '@/lib/pay-page.server';
import { PAYMENT_METHOD_COPY, paymentMethodsFor, type PaymentMethod } from '@/lib/payment-methods';
import { isOutstanding } from '@/lib/payment-status';

export const dynamic = 'force-dynamic';

/** One method's details, inside its chooser row. */
function MethodPanel({
  method,
  amount,
  currency,
  reference,
}: {
  method: PaymentMethod;
  amount: number;
  currency: Currency;
  reference: string;
}) {
  switch (method.kind) {
    case 'bank_transfer':
      return (
        <>
          <p className="type-body">
            Transfer <span className="type-number">{formatMoney(amount, currency)}</span> to:
          </p>
          <PaymentDetails iban={method.iban} beneficiary={method.beneficiary} reference={reference} />
        </>
      );
    case 'epc_qr':
      return (
        <PaymentQr iban={method.iban} beneficiary={method.beneficiary} amount={amount} remittance={reference} />
      );
    default: {
      // A kind added to `PaymentMethod` without a panel fails the build here.
      const unhandled: never = method;
      log.error({ kind: String((unhandled as { kind?: unknown }).kind) }, 'pay page: unhandled payment method kind');
      return null;
    }
  }
}

// One class's payment for the signed-in student: how to pay it, or that it
// is settled.
export default async function PayPage({ params }: { params: Promise<{ classId: string }> }) {
  const session = await getSession();
  if (!session?.studentId) redirectNonStudent(session);
  const { classId } = await params;

  // Keyed by the session's own student: another student's class finds no
  // row, and answers exactly as a class that does not exist.
  const registration = await prisma.registration.findUnique({
    where: { classId_studentId: { classId, studentId: session.studentId } },
    include: {
      payment: true,
      class: {
        include: {
          calendarEntry: {
            include: {
              teacher: {
                select: {
                  firstName: true,
                  lastName: true,
                  bankIban: true,
                  bankAccountName: true,
                  defaultTimezone: true,
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
    });
    notFound();
  }

  const cls = registration.class;
  const entry = cls.calendarEntry;
  const teacher = entry.teacher;
  const amount = Number(payment.amount);
  const reference = `${entry.classType} ${formatDayHeader(entry.date)}`;
  const methods = paymentMethodsFor(teacher, cls.currency);
  const state = paymentStateText(payment.status);
  // A waived payment is not charged, so it gets no line saying it still is.
  const chargeNote = payment.status === 'not_charged' ? null : chargeNoteFor(registration.status);
  const breakdown = resolveReportedPaymentBreakdown(
    {
      classStatus: cls.status,
      roomCost: cls.roomCost,
      totalRevenue: cls.totalRevenue,
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
      <PayBody
        status={payment.status}
        methods={methods}
        amount={amount}
        currency={cls.currency}
        reference={reference}
        teacherFirstName={teacher.firstName}
        paymentId={payment.id}
        paidAt={payment.paidAt}
        timeZone={teacher.defaultTimezone}
      />
      {breakdown.kind === 'shown' && (
        <PaymentBreakdown lines={breakdown.lines} classType={entry.classType} date={entry.date} currency={cls.currency} />
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
  timeZone,
}: {
  status: PaymentStatus;
  methods: PaymentMethod[];
  amount: number;
  currency: Currency;
  reference: string;
  teacherFirstName: string;
  paymentId: string;
  paidAt: Date | null;
  timeZone: string;
}) {
  switch (status) {
    case 'paid':
      return <p className="type-body mb-6">{markedPaidLine(paidAt, timeZone, paymentId)}</p>;
    case 'not_charged':
      return <p className="type-body mb-6">{`${teacherFirstName} isn’t charging for this class.`}</p>;
    case 'pending':
    case 'overdue':
      if (methods.length === 0) {
        return (
          <p className="type-body mb-6">
            {`Pay ${teacherFirstName} directly — cash or transfer, whatever you two agreed. They’ll mark it as received.`}
          </p>
        );
      }
      return (
        <section className="mb-6">
          <h2 className="type-subtitle mb-3">How would you like to pay?</h2>
          <div className="border-t border-border">
            {methods.map((method) => (
              // A shared `name` makes the rows exclusive: opening one closes the others.
              <details key={method.kind} name="pay-method" className="border-b border-border">
                <summary className="min-h-14 py-3 cursor-pointer">
                  <span className="text-base text-ink">{PAYMENT_METHOD_COPY[method.kind].label}</span>
                  <span className="block type-caption">{PAYMENT_METHOD_COPY[method.kind].hint}</span>
                </summary>
                <div className="pb-4">
                  <MethodPanel method={method} amount={amount} currency={currency} reference={reference} />
                </div>
              </details>
            ))}
          </div>
        </section>
      );
    default: {
      // A status added to `PaymentStatus` without a body fails the build here.
      const unhandled: never = status;
      log.error({ status: String(unhandled) }, 'pay page: unhandled payment status');
      return null;
    }
  }
}
