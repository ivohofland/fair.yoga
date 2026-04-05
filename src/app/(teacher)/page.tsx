import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { ClassList } from '@/components/schedule/class-list';
import { InboxSection } from '@/components/layout/inbox-section';

function getWeekBounds(): { start: Date; end: Date } {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setDate(now.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return { start, end };
}

export default async function TeacherHome() {
  const session = await requireTeacherSession();
  const { start, end } = getWeekBounds();

  const [classes, unreadNotifications] = await Promise.all([
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
    prisma.notification.findMany({
      where: {
        recipientType: 'teacher',
        recipientId: session.userId,
        isRead: false,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const unreadCount = unreadNotifications.length;

  return (
    <div className="flex flex-col gap-8">
      {/* This week */}
      <section>
        <h2 className="font-heading text-xl font-bold text-teal border-b border-border pb-4 mb-4">
          This week
        </h2>
        <ClassList classes={classes} />
        <Link href="/schedule" className="text-teal text-sm mt-4 inline-block">
          See full schedule &rarr;
        </Link>
      </section>

      {/* Students */}
      <section>
        <h2 className="font-heading text-xl font-bold text-teal border-b border-border pb-4 mb-4">
          Students
        </h2>
        <div className="flex flex-col gap-3">
          <Link href="/students/new" className="text-teal text-sm">
            + Add student
          </Link>
          <Link href="/students" className="text-teal text-sm">
            View all &rarr;
          </Link>
        </div>
      </section>

      {/* Inbox */}
      <section>
        <h2 className="font-heading text-xl font-bold text-teal border-b border-border pb-4 mb-4">
          Inbox{unreadCount > 0 && ` (${unreadCount})`}
        </h2>
        {unreadCount > 0 ? (
          <InboxSection notifications={unreadNotifications} />
        ) : (
          <p className="text-brown text-sm">No unread messages.</p>
        )}
        <Link href="/inbox" className="text-teal text-sm mt-4 inline-block">
          View all &rarr;
        </Link>
      </section>

      {/* Settings */}
      <section>
        <h2 className="font-heading text-xl font-bold text-teal border-b border-border pb-4 mb-4">
          Settings
        </h2>
        <div className="flex flex-col gap-3">
          <Link href="/settings/recurring" className="text-teal text-sm">
            Recurring classes &rarr;
          </Link>
          <Link href="/settings/rooms" className="text-teal text-sm">
            Rooms &rarr;
          </Link>
          <Link href="/settings/profile" className="text-teal text-sm">
            Profile &rarr;
          </Link>
        </div>
      </section>
    </div>
  );
}
