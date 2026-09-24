import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { Icon } from '@/components/ui/icon';
import { NotificationList } from '@/components/layout/notification-list';
import { listNotificationPage } from '@/services/notifications';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/notification-paging';

export const dynamic = 'force-dynamic';

// The student's notifications, newest first; older ones load on request (communication layer 2).
export default async function StudentUpdatesPage() {
  const session = await getSession();
  if (!session?.studentId) redirectNonStudent(session);

  const { notifications, hrefById, nextCursor } = await listNotificationPage(
    prisma,
    [{ recipientType: 'student', recipientId: session.studentId }],
    { limit: NOTIFICATION_PAGE_SIZE },
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
      <NotificationList
        notifications={notifications}
        hrefById={hrefById}
        paging={{ audience: 'student', nextCursor }}
      />
    </div>
  );
}
