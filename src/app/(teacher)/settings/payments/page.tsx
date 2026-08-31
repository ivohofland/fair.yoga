import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { OutstandingPaymentRow } from '@/components/class/outstanding-payment-row';
import { ReceivedPaymentRow } from '@/components/class/received-payment-row';
import { teacherVisibleName, studentNameSelect } from '@/lib/student-visibility';

export const dynamic = 'force-dynamic';

// Cross-class payment overview: who still owes what, and what came in.
// Unpaid is brown — a fact, not an alarm.
export default async function PaymentsOverviewPage() {
  const session = await requireTeacherSession();

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
              calendarEntry: { select: { classType: true, date: true, startTime: true } },
            },
          },
        },
      },
    },
  });

  const outstanding = payments.filter((p) => p.status !== 'paid');
  const received = payments.filter((p) => p.status === 'paid').slice(0, 30);
  const outstandingTotal = outstanding.reduce((sum, p) => sum + Number(p.amount), 0);
  const receivedTotal = payments
    .filter((p) => p.status === 'paid')
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const studentName = (p: (typeof payments)[number]) =>
    teacherVisibleName(p.registration.student, session.teacherId);

  return (
    <div>
      <PageHeader title="Payments" backHref="/settings" backLabel="Settings" />

      <div className="flex gap-3 mb-8">
        <div className="flex-1 bg-sand-soft border border-border rounded-card p-5">
          <p className="type-label">Outstanding</p>
          <p className="type-number text-[28px] leading-[1.25] mt-1 text-brown">
            €{outstandingTotal.toFixed(2)}
          </p>
          <p className="type-caption mt-0.5">
            {outstanding.length} {outstanding.length === 1 ? 'payment' : 'payments'}
          </p>
        </div>
        <div className="flex-1 bg-teal-tint rounded-card p-5">
          <p className="type-label">Received</p>
          <p className="type-number text-[28px] leading-[1.25] mt-1">
            €{receivedTotal.toFixed(2)}
          </p>
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
            />
          ))
        )}
      </section>
    </div>
  );
}
