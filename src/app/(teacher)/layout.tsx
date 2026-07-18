import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db';
import { TabBar } from '@/components/layout/tab-bar';
import { LiveUpdates } from '@/components/layout/live-updates';

export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session || session.userType !== 'teacher') {
    redirect('/login');
  }

  // Unread dot on the Inbox tab. Indexed by [recipientType, recipientId, isRead].
  const unreadCount = await prisma.notification.count({
    where: {
      recipientType: 'teacher',
      recipientId: session.userId,
      isRead: false,
    },
  });

  return (
    <>
      <LiveUpdates />
      {children}
      <TabBar unreadCount={unreadCount} />
    </>
  );
}
