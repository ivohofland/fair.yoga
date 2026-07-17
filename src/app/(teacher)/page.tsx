import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { ClassList } from '@/components/schedule/class-list';

function getWeekBounds(): { start: Date; end: Date } {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() + diffToMonday);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start, end };
}

function formatTodayLabel(date: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

// The Schedule tab is the home base: this week's classes as cards.
// Students, Inbox, and Settings live in their own tabs.
export default async function TeacherHome() {
  const session = await requireTeacherSession();
  const { start, end } = getWeekBounds();
  const now = new Date();

  const [classes, studioClasses] = await Promise.all([
    prisma.class.findMany({
      where: {
        teacherId: session.userId,
        date: { gte: start, lt: end },
      },
      orderBy: { date: 'asc' },
      include: {
        _count: { select: { registrations: true } },
        teacherRoom: { include: { room: true } },
      },
    }),
    prisma.studioClass.findMany({
      where: {
        teacherId: session.userId,
        date: { gte: start, lt: end },
      },
      orderBy: { date: 'asc' },
    }),
  ]);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-6">
        <div>
          <h1 className="type-display">Schedule</h1>
          <p className="type-caption mt-1">{formatTodayLabel(now)}</p>
        </div>
        <Link href="/class/new" className="type-label text-teal no-underline shrink-0">
          + Add class
        </Link>
      </div>

      <ClassList
        classes={classes}
        studioClasses={studioClasses}
        emptyMessage="No classes this week"
        showAddLink={false}
        dimPast
      />

      <div className="flex flex-col items-start gap-3 mt-8">
        <Link href="/studio-class/new" className="type-label text-teal no-underline">
          Log a studio class
        </Link>
        <Link href="/schedule/past" className="type-label text-teal no-underline">
          View past classes
        </Link>
      </div>
    </div>
  );
}
