import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { startOfLocalDay, classStartInstant } from '@/lib/timezone';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMoneyCents } from '@/lib/format';
import { buildReport, type EarningsTotals } from '@/lib/reporting';

export const dynamic = 'force-dynamic';

/** One line per currency, right-aligned, where a single figure used to stand. */
function MoneyLines({ totals, className }: { totals: EarningsTotals; className: string }) {
  return (
    <span className="flex flex-col items-end">
      {totals.map((t) => (
        <span key={t.currency} className={className}>
          {t.cents === null ? '—' : formatMoneyCents(t.cents, t.currency)}
        </span>
      ))}
    </span>
  );
}

// Income overview: what teaching earned, shown the same way prices are
// shown to students — transparent, no charts, no growth talk.
export default async function ReportingPage() {
  const session = await requireTeacherSession();
  const currency = await teacherCurrency(session.teacherId);
  const now = new Date();
  // #101. `CalendarEntry.date` is a `@db.Date` calendar date; `new Date()` is an
  // instant. Comparing them directly meant that west of UTC, in the teacher's
  // local evening, UTC had already rolled over and a studio class dated
  // *tomorrow* satisfied `lte` — putting a class they have not taught into
  // their earnings and their class count — this page reports classes, students
  // and earnings, and a studio class contributes to all three. The end of the
  // teacher's today is the boundary that belongs here.
  const endOfToday = startOfLocalDay(now, session.defaultTimezone);
  endOfToday.setUTCHours(23, 59, 59, 999);

  const [completedClasses, studioClasses, distinctStudents] = await Promise.all([
    // `status: 'completed'` needs no `cancelledAt` conjunct of its own: a
    // cancelled class never completes, because `completeClass` and both
    // transition doors refuse one. It is the terminal fact this page reports
    // on, not a liveness filter.
    prisma.class.findMany({
      where: { calendarEntry: { teacherId: session.teacherId }, status: 'completed' },
      select: {
        currency: true,
        pricingMode: true,
        donationTotal: true,
        vatPercent: true,
        totalRevenue: true,
        vatTotal: true,
        roomCost: true,
        totalStudents: true,
        calendarEntry: { select: { date: true } },
      },
      orderBy: { calendarEntry: { date: 'desc' } },
    }),
    prisma.studioClass.findMany({
      where: {
        calendarEntry: {
          teacherId: session.teacherId,
          cancelledAt: null,
          date: { lte: endOfToday },
        },
      },
      select: {
        currency: true,
        hourlyRate: true,
        studentCount: true,
        calendarEntry: { select: { date: true, durationMinutes: true, startTime: true } },
      },
      orderBy: { calendarEntry: { date: 'desc' } },
    }),
    prisma.registration.findMany({
      where: {
        class: { calendarEntry: { teacherId: session.teacherId }, status: 'completed' },
        status: { in: ['registered', 'attended', 'no_show', 'late_cancel'] },
      },
      distinct: ['studentId'],
      select: { studentId: true },
    }),
  ]);

  // #278. A studio class contributes to earnings, class count and the month
  // rollup only once its start instant has passed — `classStartInstant` <= now.
  // Classes dated today with a start time in the future are excluded.
  const completedStudioClasses = studioClasses.filter(
    (s) => classStartInstant(s.calendarEntry, session.defaultTimezone) <= now,
  );

  const report = buildReport(completedClasses, completedStudioClasses, currency);
  const hasDonationClass = completedClasses.some((c) => c.pricingMode === 'donation');

  const nothingYet = report.classCount === 0;

  return (
    <div>
      <PageHeader title="Reporting" backHref="/settings" backLabel="Settings" />

      {nothingYet ? (
        <EmptyState
          title="Nothing to report yet"
          body="Completed classes and what they earned appear here."
        />
      ) : (
        <>
          <div className="bg-teal-tint rounded-card p-5 text-center">
            <p className="type-label">Earned from teaching</p>
            {report.total.map((t) => (
              <p key={t.currency} data-testid="report-total" className="type-number text-[28px] leading-[1.25] mt-1">
                {t.cents === null ? '—' : formatMoneyCents(t.cents, t.currency)}
              </p>
            ))}
            {report.total.map((t) =>
              t.cents === null ? (
                <p key={t.currency} className="type-caption mt-0.5">
                  {report.total.length > 1 ? `${t.currency} · ` : ''}Not recorded yet
                </p>
              ) : null,
            )}
            <p className="type-caption mt-0.5">
              {report.classCount} classes · {distinctStudents.length}{' '}
              {distinctStudents.length === 1 ? 'student' : 'students'} reached
            </p>
          </div>

          <div className="mt-4">
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Your classes</span>
              <MoneyLines totals={report.tiered} className="type-number" />
            </div>
            {hasDonationClass && (
              <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
                <div>
                  <span className="type-body">Donation classes</span>
                  {report.unrecordedDonationCount > 0 && (
                    <p className="type-caption">{report.unrecordedDonationCount} without a recorded total</p>
                  )}
                </div>
                <MoneyLines totals={report.donation} className="type-number" />
              </div>
            )}
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Studio classes</span>
              <MoneyLines totals={report.studio} className="type-number" />
            </div>
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Room costs paid</span>
              <MoneyLines totals={report.roomCosts} className="tabular-nums text-brown" />
            </div>
          </div>

          {report.months.length > 0 && (
            <section className="mt-8">
              <h2 className="type-subtitle mb-1">By month</h2>
              <div className="flex items-center justify-between gap-2 py-2 border-b border-border text-[12px] font-medium text-teal">
                <span className="flex-1">MONTH</span>
                <span className="w-20 text-right">CLASSES</span>
                <span className="w-20 text-right">STUDENTS</span>
                <span className="w-24 text-right">EARNED</span>
              </div>
              {report.months.map((m) => (
                <div
                  key={m.label}
                  className="flex items-center justify-between gap-2 min-h-12 py-2 border-b border-border last:border-b-0"
                >
                  <span className="flex-1 text-base text-ink">{m.label}</span>
                  <span className="w-20 text-right text-sm text-brown tabular-nums">{m.classes}</span>
                  <span className="w-20 text-right text-sm text-brown tabular-nums">{m.students}</span>
                  <MoneyLines totals={m.earnings} className="w-24 text-right type-number text-sm" />
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
