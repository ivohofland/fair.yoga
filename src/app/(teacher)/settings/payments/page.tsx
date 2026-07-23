import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { MarkUnpaidButton } from '@/components/class/mark-unpaid-button';
import { OutstandingPaymentRow } from '@/components/class/outstanding-payment-row';
import { formatStudentName } from '@/lib/format';

export const dynamic = 'force-dynamic';

function formatDay(date: Date): string {
  const d = new Date(date);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Cross-class payment overview: who still owes what, and what came in.
// Unpaid is brown — a fact, not an alarm.
export default async function PaymentsOverviewPage() {
  const session = await requireTeacherSession();

  const payments = await prisma.payment.findMany({
    where: { registration: { class: { teacherId: session.teacherId } } },
    orderBy: { createdAt: 'desc' },
    include: {
      registration: {
        select: {
          studentId: true,
          student: {
            select: {
              firstName: true,
              lastName: true,
              claimedAt: true,
              studentPrivacy: {
                where: { teacherId: session.teacherId },
                select: { shareFullName: true },
              },
            },
          },
          class: { select: { id: true, classType: true, date: true } },
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

  const studentName = (p: (typeof payments)[number]) => {
    const s = p.registration.student;
    return formatStudentName(
      s.firstName,
      s.lastName,
      !s.claimedAt || (s.studentPrivacy[0]?.shareFullName ?? false),
    );
  };

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
              classContext={`${p.registration.class.classType} · ${formatDay(p.registration.class.date)}`}
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
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0"
            >
              <div className="min-w-0">
                <p className="text-base text-ink">{studentName(p)}</p>
                <p className="type-caption">
                  {p.registration.class.classType} · {formatDay(p.registration.class.date)}
                  {p.paidAt && <> · ✓ paid {formatDay(p.paidAt)}</>}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="type-number">€{Number(p.amount).toFixed(2)}</span>
                <MarkUnpaidButton paymentId={p.id} />
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
