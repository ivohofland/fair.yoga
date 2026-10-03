import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationList } from '@/components/layout/notification-list';
import { listNotificationPage } from '@/services/notifications';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/notification-paging';

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ n?: string | string[] }>;
}) {
  const session = await requireTeacherSession();

  const { notifications, hrefById, nextCursor } = await listNotificationPage(
    prisma,
    [{ recipientType: 'teacher', recipientId: session.teacherId }],
    { limit: NOTIFICATION_PAGE_SIZE },
  );
  const { n } = await searchParams;

  return (
    <>
      <PageHeader title="Inbox" backHref={null} variant="display" />
      <div data-layout-anchor="first-item">
        <NotificationList
          notifications={notifications}
          hrefById={hrefById}
          paging={{ audience: 'teacher', nextCursor }}
          highlightId={typeof n === 'string' ? n : undefined}
        />
      </div>
    </>
  );
}
