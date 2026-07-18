import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { ClassList } from '@/components/schedule/class-list';
import { GettingStarted } from '@/components/schedule/getting-started';

/**
 * The home window: the current week so far (completed classes stay in
 * view for payments) plus four weeks ahead — matching how far recurring
 * templates generate. A strict this-week view hid every newly created
 * class until its week arrived.
 */
function getScheduleWindow(): { start: Date; end: Date } {
  const now = new Date();
  const day = now.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() + diffToMonday);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() + 28);
  end.setUTCHours(23, 59, 59, 999);
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

// The Schedule tab is the home base: this week plus the coming four
// weeks as cards. Students, Inbox, and Settings live in their own tabs.
export default async function TeacherHome() {
  const session = await requireTeacherSession();
  const { start, end } = getScheduleWindow();
  const now = new Date();

  const [classes, studioClasses, teacher, roomCount, classCount] = await Promise.all([
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
    prisma.teacher.findUniqueOrThrow({
      where: { id: session.userId },
      select: { bankIban: true },
    }),
    prisma.teacherRoom.count({ where: { teacherId: session.userId, isArchived: false } }),
    prisma.class.count({ where: { teacherId: session.userId } }),
  ]);

  // The checklist retires itself once the teacher has taught the basics
  // into place: bank details, a room, a first class.
  // Bank details are optional (cash-only teachers exist) — the card retires
  // on the two required steps, or it would pin itself forever.
  const needsOnboarding = roomCount === 0 || classCount === 0;

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

      {needsOnboarding && (
        <GettingStarted
          hasBankDetails={Boolean(teacher.bankIban)}
          hasRoom={roomCount > 0}
          hasClass={classCount > 0}
        />
      )}

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
