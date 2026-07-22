import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { NotificationsForm } from '@/components/student/notifications-form';

export const dynamic = 'force-dynamic';

export default async function NotificationSettingsPage() {
  const session = await getSession();
  if (!session?.studentId) redirect(session?.teacherId ? '/' : '/login');

  const student = await prisma.student.findUnique({
    where: { id: session.studentId },
    select: { id: true, emailNotifications: true, reminderPref: true },
  });
  if (!student) redirect('/login');

  return (
    <div>
      <Link
        href="/account"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Settings
      </Link>
      <h1 className="type-title mb-6">Notifications</h1>
      <NotificationsForm
        studentId={student.id}
        emailNotifications={student.emailNotifications}
        reminderPref={student.reminderPref}
      />
    </div>
  );
}
