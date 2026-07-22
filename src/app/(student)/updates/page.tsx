import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { NotificationList } from '@/components/layout/notification-list';

export const dynamic = 'force-dynamic';

// The student's persistent record — the strip on /bookings previews
// unread; this page keeps everything (communication layer 2).
export default async function StudentUpdatesPage() {
  const session = await getSession();
  if (!session?.studentId) redirect(session?.teacherId ? '/' : '/login');

  const notifications = await prisma.notification.findMany({
    where: { recipientType: 'student', recipientId: session.studentId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    include: {
      relatedClass: {
        select: { id: true, status: true, teacher: { select: { pageSlug: true } } },
      },
    },
  });

  // Student-side link targets: the public booking page while booking
  // still makes sense, nothing otherwise (the default would point at
  // teacher-only class routes).
  const hrefById = Object.fromEntries(
    notifications.map((n) => [
      n.id,
      n.relatedClass && n.relatedClass.status === 'open'
        ? `/${n.relatedClass.teacher.pageSlug}/book/${n.relatedClass.id}`
        : null,
    ]),
  );

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-title mb-6">All updates</h1>
      <NotificationList notifications={notifications} hrefById={hrefById} />
    </div>
  );
}
