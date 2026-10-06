import type { Currency, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { teacherCurrency } from '@/lib/teacher-currency.server';
import { startOfLocalDay, classStartInstant } from '@/lib/timezone';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { formatMonthLabel, formatMoneyCents } from '@/lib/format';
import { orZero, totalsByCurrency, type MoneyTotals } from '@/lib/money-totals';

export const dynamic = 'force-dynamic';

function monthKey(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}`;
}

/** One line per currency, right-aligned, where a single figure used to stand. */
function MoneyLines({ totals, className }: { totals: MoneyTotals; className: string }) {
  return (
    <span className="flex flex-col items-end">
      {totals.map((t) => (
        <span key={t.currency} className={className}>
          {formatMoneyCents(t.cents, t.currency)}
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
        totalRevenue: true,
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

  const toCents = (val: Prisma.Decimal | number | string | null | undefined): number =>
    Math.round(Number(val ?? 0) * 100);

  const classEarningsCents = (c: (typeof completedClasses)[number]) =>
    toCents(c.totalRevenue) - toCents(c.roomCost);
  const studioEarningsCents = (s: (typeof completedStudioClasses)[number]) =>
    Math.round((toCents(s.hourlyRate) * s.calendarEntry.durationMinutes) / 60);

  // Every figure below is a list of per-currency totals: an amount is never
  // added to one in another currency (`money-totals.ts`).
  const classEarnings = completedClasses.map((c) => ({
    currency: c.currency,
    amount: classEarningsCents(c) / 100,
  }));
  const studioEarnings = completedStudioClasses.map((s) => ({
    currency: s.currency,
    amount: studioEarningsCents(s) / 100,
  }));
  const totalClassEarnings = orZero(totalsByCurrency(classEarnings, currency), currency);
  const totalStudioEarnings = orZero(totalsByCurrency(studioEarnings, currency), currency);
  const totalEarnings = orZero(totalsByCurrency([...classEarnings, ...studioEarnings], currency), currency);
  const totalRoomCosts = orZero(
    totalsByCurrency(
      completedClasses.map((c) => ({ currency: c.currency, amount: toCents(c.roomCost) / 100 })),
      currency,
    ),
    currency,
  );

  // Accumulate classes, students, and earnings by month key (YYYY-MM)
  const byMonth = new Map<
    string,
    { classes: number; students: number; earnings: { currency: Currency; amount: number }[] }
  >();
  for (const c of completedClasses) {
    const key = monthKey(c.calendarEntry.date);
    const entry = byMonth.get(key) ?? { classes: 0, students: 0, earnings: [] };
    entry.classes += 1;
    entry.students += c.totalStudents ?? 0;
    entry.earnings.push({ currency: c.currency, amount: classEarningsCents(c) / 100 });
    byMonth.set(key, entry);
  }
  for (const s of completedStudioClasses) {
    const key = monthKey(s.calendarEntry.date);
    const entry = byMonth.get(key) ?? { classes: 0, students: 0, earnings: [] };
    entry.classes += 1;
    entry.students += s.studentCount ?? 0;
    entry.earnings.push({ currency: s.currency, amount: studioEarningsCents(s) / 100 });
    byMonth.set(key, entry);
  }
  // Last six calendar months, newest first
  const months = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 6)
    .map(([key, v]) => {
      const [year, month] = key.split('-');
      return {
        label: formatMonthLabel(Number(year), Number(month)),
        classes: v.classes,
        students: v.students,
        earnings: orZero(totalsByCurrency(v.earnings, currency), currency),
      };
    });

  const nothingYet = completedClasses.length === 0 && completedStudioClasses.length === 0;

  return (
    <div>
      <PageHeader title="Reporting" backHref="/settings" backLabel="Settings" />

      {nothingYet ? (
        <EmptyState
          title="Nothing to report yet"
          body="Completed classes and what they charged appear here."
        />
      ) : (
        <>
          <div className="bg-teal-tint rounded-card p-5 text-center">
            <p className="type-label">Total charged for teaching</p>
            {totalEarnings.map((t) => (
              <p key={t.currency} data-testid="report-total" className="type-number text-[28px] leading-[1.25] mt-1">
                {formatMoneyCents(t.cents, t.currency)}
              </p>
            ))}
            <p className="type-caption mt-0.5">
              {completedClasses.length + completedStudioClasses.length} classes · {distinctStudents.length}{' '}
              {distinctStudents.length === 1 ? 'student' : 'students'} reached
            </p>
          </div>

          <div className="mt-4">
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Your classes</span>
              <MoneyLines totals={totalClassEarnings} className="type-number" />
            </div>
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Studio classes</span>
              <MoneyLines totals={totalStudioEarnings} className="type-number" />
            </div>
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Room costs paid</span>
              <MoneyLines totals={totalRoomCosts} className="tabular-nums text-brown" />
            </div>
          </div>

          {months.length > 0 && (
            <section className="mt-8">
              <h2 className="type-subtitle mb-1">By month</h2>
              <div className="flex items-center justify-between gap-2 py-2 border-b border-border text-[12px] font-medium text-teal">
                <span className="flex-1">MONTH</span>
                <span className="w-20 text-right">CLASSES</span>
                <span className="w-20 text-right">STUDENTS</span>
                <span className="w-24 text-right">CHARGED</span>
              </div>
              {months.map((m) => (
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
