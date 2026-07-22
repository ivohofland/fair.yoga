import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
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
  // A signed-in student-only account belongs on its own home, not a
  // sign-in form it cannot use — except /settings, which courteously
  // maps to their own settings (x-pathname stamped by the middleware).
  if (!session?.teacherId) {
    if (session?.studentId) {
      const pathname = (await headers()).get('x-pathname') ?? '';
      redirect(pathname.startsWith('/settings') ? '/account' : '/bookings');
    }
    redirect('/login');
  }

  // Unread dot on the Inbox tab. Indexed by [recipientType, recipientId, isRead].
  const unreadCount = await prisma.notification.count({
    where: {
      recipientType: 'teacher',
      recipientId: session.teacherId,
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
