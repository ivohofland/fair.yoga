import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { ClassList } from '@/components/schedule/class-list';
import { InboxSection } from '@/components/layout/inbox-section';
import { RunningHeader } from '@/components/layout/running-header';
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

function formatTodayLabel(date: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

export default async function TeacherHome() {
  const session = await requireTeacherSession();
  const { start, end } = getWeekBounds();

  const now = new Date();

  const [classes, studioClasses, unreadNotifications, recentRegistrations] = await Promise.all([
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
    prisma.notification.findMany({
      where: {
        recipientType: 'teacher',
        recipientId: session.userId,
        isRead: false,
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.registration.findMany({
      where: {
        class: { teacherId: session.userId, date: { lt: now } },
        status: { in: ['registered', 'attended'] },
      },
      orderBy: { registeredAt: 'desc' },
      distinct: ['studentId'],
      take: 10,
      select: {
        id: true,
        studentId: true,
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
    }),
  ]);

  const unreadCount = unreadNotifications.length;
  const weekClassCount = classes.length + studioClasses.length;

  return (
    <div>
      <RunningHeader pageLabel={formatTodayLabel(now)} />

      <div className="flex flex-col gap-12">
        {/* Schedule */}
        <section>
          <SubHead title="Schedule" action={{ label: 'Add class', href: '/class/new' }} />
          <ClassList classes={classes} studioClasses={studioClasses} showAddLink={false} dimPast />
          {weekClassCount > 0 && (
            <Colophon href="/schedule">
              {weekClassCount} {weekClassCount === 1 ? 'class' : 'classes'} this week &middot; see full schedule
            </Colophon>
          )}
        </section>

        {/* Students */}
        <section>
          <SubHead title="Students" action={{ label: 'Add student', href: '/students/new' }} />
          {recentRegistrations.length > 0 ? (
            <div>
              {recentRegistrations.map((reg, i) => (
                <Link
                  key={reg.id}
                  href={`/students/${reg.student.id}`}
                  className={`flex items-center py-4 border-b border-border no-underline${i === recentRegistrations.length - 1 ? ' border-b-0' : ''}`}
                >
                  <span className="text-[15px] text-dark font-semibold">
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
            <p className="fy-lede">No recent students.</p>
          )}
          {recentRegistrations.length > 0 && (
            <Colophon href="/students">View all students</Colophon>
          )}
        </section>

        {/* Inbox */}
        <section>
          <SubHead title="Inbox" action={{ label: 'View all', href: '/inbox' }} />
          {unreadCount > 0 ? (
            <>
              <InboxSection notifications={unreadNotifications} />
              <Colophon>
                {unreadCount} unread
              </Colophon>
            </>
          ) : (
            <p className="fy-lede">No unread messages.</p>
          )}
        </section>

        {/* Settings */}
        <section>
          <SubHead title="Settings" />
          <div className="flex flex-col">
            <Link href="/settings/recurring" className="py-3 border-b border-border text-[15px] text-dark no-underline">
              Recurring classes
            </Link>
            <Link href="/settings/studio-classes" className="py-3 border-b border-border text-[15px] text-dark no-underline">
              Studio classes
            </Link>
            <Link href="/settings/rooms" className="py-3 border-b border-border text-[15px] text-dark no-underline">
              Rooms
            </Link>
            <Link href="/settings/profile" className="py-3 text-[15px] text-dark no-underline">
              Profile
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

interface SubHeadProps {
  title: string;
  action?: { label: string; href: string };
  meta?: string;
}

function SubHead({ title, action, meta }: SubHeadProps) {
  return (
    <div
      className="flex items-baseline justify-between pb-[14px] mb-5"
      style={{ borderBottom: '1px solid var(--color-brown)' }}
    >
      <h2 className="font-heading font-bold text-[22px] text-dark leading-[1.1]">{title}</h2>
      {action && (
        <Link
          href={action.href}
          className="text-[13px] text-brown"
        >
          {action.label}
        </Link>
      )}
      {meta && (
        <span className="text-[13px] text-brown fy-oldstyle">
          {meta}
        </span>
      )}
    </div>
  );
}

function Colophon({ children, href }: { children: React.ReactNode; href?: string }) {
  const className =
    'block text-right mt-[14px] font-heading italic text-[12px] text-brown opacity-75 fy-oldstyle';
  if (href) {
    return (
      <Link href={href} className={`${className} no-underline`}>
        {children}
      </Link>
    );
  }
  return <p className={className}>{children}</p>;
}
