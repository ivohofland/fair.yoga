import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { formatMoneyCents } from '@/lib/format';
import { totalsByCurrency, orZero } from '@/lib/money-totals';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { OutstandingPaymentRow } from '@/components/class/outstanding-payment-row';
import { ReceivedPaymentRow } from '@/components/class/received-payment-row';
import { NotChargedPaymentRow } from '@/components/class/not-charged-payment-row';
import { teacherVisibleName, studentNameSelect } from '@/lib/student-visibility';
import { isOutstanding } from '@/lib/payment-status';

export const dynamic = 'force-dynamic';

// Cross-class payment overview: who still owes what, and what came in.
// Unpaid is brown — a fact, not an alarm.
export default async function PaymentsOverviewPage() {
  const session = await requireTeacherSession();
  const currency = await teacherCurrency(session.teacherId);

  const payments = await prisma.payment.findMany({
    where: { registration: { class: { calendarEntry: { teacherId: session.teacherId } } } },
    orderBy: { createdAt: 'desc' },
    include: {
      registration: {
        select: {
          student: { select: studentNameSelect(session.teacherId) },
          class: {
            select: {
              id: true,
              currency: true,
              calendarEntry: { select: { classType: true, date: true, startTime: true } },
            },
          },
        },
      },
    },
  });

  const outstanding = payments.filter((p) => isOutstanding(p.status));
  const receivedAll = payments.filter((p) => p.status === 'paid');
  const received = receivedAll.slice(0, 30);
  const notCharged = payments.filter((p) => p.status === 'not_charged').slice(0, 30);
  const toItems = (rows: typeof payments) =>
    rows.map((p) => ({ currency: p.registration.class.currency, amount: p.amount }));
  const outstandingTotals = orZero(totalsByCurrency(toItems(outstanding), currency), currency);
  const receivedTotals = orZero(totalsByCurrency(toItems(receivedAll), currency), currency);

  const studentName = (p: (typeof payments)[number]) =>
    teacherVisibleName(p.registration.student, session.teacherId);

  return (
    <div>
      <PageHeader title="Payments" backHref="/settings" backLabel="Settings" />

      <div className="flex gap-3 mb-8">
        <div className="flex-1 bg-sand-soft border border-border rounded-card p-5">
          <p className="type-label">Outstanding</p>
          {outstandingTotals.map((t) => (
            <p key={t.currency} data-testid="outstanding-total" className="type-number text-[28px] leading-[1.25] mt-1 text-brown">
              {formatMoneyCents(t.cents, t.currency)}
            </p>
          ))}
          <p className="type-caption mt-0.5">
            {outstanding.length} {outstanding.length === 1 ? 'payment' : 'payments'}
          </p>
        </div>
        <div className="flex-1 bg-teal-tint rounded-card p-5">
          <p className="type-label">Received</p>
          {receivedTotals.map((t) => (
            <p key={t.currency} data-testid="received-total" className="type-number text-[28px] leading-[1.25] mt-1">
              {formatMoneyCents(t.cents, t.currency)}
            </p>
          ))}
          <p className="type-caption mt-0.5">all time</p>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="type-subtitle mb-1">Outstanding</h2>
        {outstanding.length === 0 ? (
          <EmptyState title="Nothing outstanding" body="All payments are settled." />
        ) : (
          outstanding.map((p) => (
            <OutstandingPaymentRow
              key={p.id}
              paymentId={p.id}
              studentName={studentName(p)}
              classId={p.registration.class.id}
              classType={p.registration.class.calendarEntry.classType}
              classDate={p.registration.class.calendarEntry.date}
              startTime={p.registration.class.calendarEntry.startTime}
              amount={Number(p.amount)}
              currency={p.registration.class.currency}
              status={p.status}
              reminderSentAt={p.reminderSentAt}
            />
          ))
        )}
      </section>

      <section>
        <h2 className="type-subtitle mb-1">Received</h2>
        {received.length === 0 ? (
          <EmptyState title="Nothing received yet" body="Paid classes appear here." />
        ) : (
          received.map((p) => (
            <ReceivedPaymentRow
              key={p.id}
              paymentId={p.id}
              studentName={studentName(p)}
              classType={p.registration.class.calendarEntry.classType}
              classDate={p.registration.class.calendarEntry.date}
              startTime={p.registration.class.calendarEntry.startTime}
              paidAt={p.paidAt}
              timeZone={session.defaultTimezone}
              amount={Number(p.amount)}
              currency={p.registration.class.currency}
            />
          ))
        )}
      </section>

      {notCharged.length > 0 && (
        <section className="mt-8">
          <h2 className="type-subtitle mb-1">Not charged</h2>
          {notCharged.map((p) => (
            <NotChargedPaymentRow
              key={p.id}
              paymentId={p.id}
              studentName={studentName(p)}
              classType={p.registration.class.calendarEntry.classType}
              classDate={p.registration.class.calendarEntry.date}
              startTime={p.registration.class.calendarEntry.startTime}
              notChargedAt={p.notChargedAt}
              timeZone={session.defaultTimezone}
              amount={Number(p.amount)}
              currency={p.registration.class.currency}
            />
          ))}
        </section>
      )}
    </div>
  );
}
