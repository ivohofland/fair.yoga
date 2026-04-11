import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationList } from '@/components/layout/notification-list';

export default async function InboxPage() {
  const session = await requireTeacherSession();

  const notifications = await prisma.notification.findMany({
    where: {
      recipientType: 'teacher',
      recipientId: session.userId,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return (
    <>
      <PageHeader title="Inbox" backHref="/" backLabel="Dashboard" />
      <NotificationList notifications={notifications} />
    </>
  );
}
