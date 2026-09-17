import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getSession } from '@/lib/session';
import { prisma } from '@/lib/db';
import { isSafeRelativePath } from '@/lib/schemas';
import { TabBar } from '@/components/layout/tab-bar';
import { LiveUpdates } from '@/components/layout/live-updates';

export default async function TeacherLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session?.teacherId) {
    const pathname = (await headers()).get('x-pathname');
    // A signed-in student-only account belongs on its own home, not a
    // sign-in form it cannot use — except /settings, which courteously
    // maps to their own settings.
    if (session?.studentId) {
      redirect((pathname ?? '').startsWith('/settings') ? '/account' : '/bookings');
    }
    // Unauthenticated or expired session: preserve destination URL if safe.
    if (pathname && isSafeRelativePath(pathname)) {
      redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
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
