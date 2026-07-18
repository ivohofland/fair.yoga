import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';

export const dynamic = 'force-dynamic';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthKey(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}`;
}

// Income overview: what teaching earned, shown the same way prices are
// shown to students — transparent, no charts, no growth talk.
export default async function ReportingPage() {
  const session = await requireTeacherSession();

  const [completedClasses, studioClasses, distinctStudents] = await Promise.all([
    prisma.class.findMany({
      where: { teacherId: session.userId, status: 'completed' },
      select: { date: true, totalRevenue: true, roomCost: true, totalStudents: true },
      orderBy: { date: 'desc' },
    }),
    prisma.studioClass.findMany({
      where: { teacherId: session.userId, cancelledAt: null, date: { lte: new Date() } },
      select: { date: true, durationMinutes: true, hourlyRate: true, studentCount: true },
      orderBy: { date: 'desc' },
    }),
    prisma.registration.findMany({
      where: {
        class: { teacherId: session.userId, status: 'completed' },
        status: { in: ['registered', 'attended', 'no_show', 'late_cancel'] },
      },
      distinct: ['studentId'],
      select: { studentId: true },
    }),
  ]);

  const classEarnings = (c: (typeof completedClasses)[number]) =>
    Number(c.totalRevenue ?? 0) - Number(c.roomCost);
  const studioEarnings = (s: (typeof studioClasses)[number]) =>
    (Number(s.hourlyRate) * s.durationMinutes) / 60;

  const totalClassEarnings = completedClasses.reduce((sum, c) => sum + classEarnings(c), 0);
  const totalStudioEarnings = studioClasses.reduce((sum, s) => sum + studioEarnings(s), 0);
  const totalRoomCosts = completedClasses.reduce((sum, c) => sum + Number(c.roomCost), 0);

  // Last six calendar months, newest first
  const byMonth = new Map<string, { classes: number; students: number; earnings: number }>();
  for (const c of completedClasses) {
    const key = monthKey(c.date);
    const entry = byMonth.get(key) ?? { classes: 0, students: 0, earnings: 0 };
    entry.classes += 1;
    entry.students += c.totalStudents ?? 0;
    entry.earnings += classEarnings(c);
    byMonth.set(key, entry);
  }
  for (const s of studioClasses) {
    const key = monthKey(s.date);
    const entry = byMonth.get(key) ?? { classes: 0, students: 0, earnings: 0 };
    entry.classes += 1;
    entry.students += s.studentCount ?? 0;
    entry.earnings += studioEarnings(s);
    byMonth.set(key, entry);
  }
  const months = [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 6)
    .map(([key, v]) => {
      const [year, month] = key.split('-');
      return { label: `${MONTHS[Number(month)]} ${year}`, ...v };
    });

  const nothingYet = completedClasses.length === 0 && studioClasses.length === 0;

  return (
    <div>
      <PageHeader title="Reporting" backHref="/settings" backLabel="Settings" />

      {nothingYet ? (
        <EmptyState
          title="Nothing to report yet"
          body="Completed classes and their earnings appear here."
        />
      ) : (
        <>
          <div className="bg-teal-tint rounded-card p-5 text-center">
            <p className="type-label">Total earned teaching</p>
            <p className="type-number text-[28px] leading-[1.25] mt-1">
              €{(totalClassEarnings + totalStudioEarnings).toFixed(2)}
            </p>
            <p className="type-caption mt-0.5">
              {completedClasses.length + studioClasses.length} classes · {distinctStudents.length}{' '}
              {distinctStudents.length === 1 ? 'student' : 'students'} reached
            </p>
          </div>

          <div className="mt-4">
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Your classes</span>
              <span className="type-number">€{totalClassEarnings.toFixed(2)}</span>
            </div>
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Studio classes</span>
              <span className="type-number">€{totalStudioEarnings.toFixed(2)}</span>
            </div>
            <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
              <span className="type-body">Room costs paid</span>
              <span className="tabular-nums text-brown">€{totalRoomCosts.toFixed(2)}</span>
            </div>
          </div>

          {months.length > 0 && (
            <section className="mt-8">
              <h2 className="type-subtitle mb-1">By month</h2>
              <div className="flex items-center justify-between gap-2 py-2 border-b border-border text-[12px] font-medium text-teal">
                <span className="flex-1">MONTH</span>
                <span className="w-20 text-right">CLASSES</span>
                <span className="w-20 text-right">STUDENTS</span>
                <span className="w-24 text-right">EARNED</span>
              </div>
              {months.map((m) => (
                <div
                  key={m.label}
                  className="flex items-center justify-between gap-2 min-h-12 py-2 border-b border-border last:border-b-0"
                >
                  <span className="flex-1 text-base text-ink">{m.label}</span>
                  <span className="w-20 text-right text-sm text-brown tabular-nums">{m.classes}</span>
                  <span className="w-20 text-right text-sm text-brown tabular-nums">{m.students}</span>
                  <span className="w-24 text-right type-number text-sm">€{m.earnings.toFixed(2)}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
