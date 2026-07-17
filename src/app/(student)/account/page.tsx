import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { StudentSettingsForm } from '@/components/student/student-settings-form';

export const dynamic = 'force-dynamic';

export default async function StudentSettingsPage() {
  const session = await getSession();
  if (!session || session.userType !== 'student') redirect('/login');

  const student = await prisma.student.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      firstName: true,
      email: true,
      incomeTier: true,
      emailNotifications: true,
      reminderPref: true,
    },
  });
  if (!student) redirect('/login');

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-display mb-6">Settings</h1>

      <StudentSettingsForm
        studentId={student.id}
        currentTier={student.incomeTier}
        emailNotifications={student.emailNotifications}
        reminderPref={student.reminderPref}
      />
    </div>
  );
}
