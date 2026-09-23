import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationList } from '@/components/layout/notification-list';

export default async function InboxPage() {
  const session = await requireTeacherSession();

  const notifications = await prisma.notification.findMany({
    where: {
      recipientType: 'teacher',
      recipientId: session.teacherId,
    },
    // id tie-breaker: rows created in the same instant (batch inserts) have
    // equal createdAt, and without it their order shuffles on every refresh.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
  });

  return (
    <>
      <PageHeader title="Inbox" backHref={null} variant="display" />
      <NotificationList notifications={notifications} />
    </>
  );
}
