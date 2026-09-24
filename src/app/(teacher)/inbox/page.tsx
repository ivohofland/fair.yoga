import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationList } from '@/components/layout/notification-list';
import { listNotificationPage } from '@/services/notifications';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/notification-paging';

export default async function InboxPage() {
  const session = await requireTeacherSession();

  const { notifications, hrefById, nextCursor } = await listNotificationPage(
    prisma,
    [{ recipientType: 'teacher', recipientId: session.teacherId }],
    { limit: NOTIFICATION_PAGE_SIZE },
  );

  return (
    <>
      <PageHeader title="Inbox" backHref={null} variant="display" />
      <NotificationList
        notifications={notifications}
        hrefById={hrefById}
        paging={{ audience: 'teacher', nextCursor }}
      />
    </>
  );
}
