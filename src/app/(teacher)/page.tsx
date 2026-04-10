import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { ClassList } from '@/components/schedule/class-list';
import { InboxSection } from '@/components/layout/inbox-section';
import { formatStudentName } from '@/lib/format';

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

export default async function TeacherHome() {
  const session = await requireTeacherSession();
  const { start, end } = getWeekBounds();

  const now = new Date();

  const [classes, unreadNotifications, lastClass] = await Promise.all([
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
    prisma.class.findFirst({
      where: {
        teacherId: session.userId,
        date: { lt: now },
      },
      orderBy: { date: 'desc' },
      include: {
        registrations: {
          where: { status: 'registered' },
          include: {
            student: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                claimedAt: true,
                studentPrivacy: {
                  where: { teacherId: session.userId },
                  select: { shareFullName: true },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const unreadCount = unreadNotifications.length;

  return (
    <div className="flex flex-col gap-8">
      {/* This week */}
      <section>
        <div className="flex items-center justify-between border-b border-border pb-4 mb-4">
          <h2 className="font-heading text-xl font-bold text-teal">
            This week
          </h2>
          <Link href="/class/new" className="text-teal text-sm">+ Add class</Link>
        </div>
        <ClassList classes={classes} showAddLink={false} dimPast />
        <Link href="/schedule" className="text-teal text-sm mt-4 inline-block">
          See full schedule &rarr;
        </Link>
      </section>

      {/* Students */}
      <section>
        <div className="flex items-center justify-between border-b border-border pb-4 mb-4">
          <h2 className="font-heading text-xl font-bold text-teal">
            Recent students
          </h2>
          <Link href="/students/new" className="text-teal text-sm">+ Add student</Link>
        </div>
        {lastClass && lastClass.registrations.length > 0 ? (
          <div>
              {lastClass.registrations.map((reg) => (
                <Link
                  key={reg.id}
                  href={`/students/${reg.student.id}`}
                  className="flex items-center py-2 border-b border-border"
                >
                  <span className="text-dark text-sm">
                    {formatStudentName(
                      reg.student.firstName,
                      reg.student.lastName,
                      !reg.student.claimedAt || (reg.student.studentPrivacy[0]?.shareFullName ?? false),
                    )}
                  </span>
                </Link>
              ))}
          </div>
        ) : (
          <p className="text-brown text-sm">No recent classes with students.</p>
        )}
        <Link href="/students" className="text-teal text-sm mt-4 inline-block">
          View all &rarr;
        </Link>
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
