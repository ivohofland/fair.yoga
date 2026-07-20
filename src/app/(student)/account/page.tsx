import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { StudentSettingsForm } from '@/components/student/student-settings-form';
import { DataAndDeletion } from '@/components/account/data-and-deletion';
import { AddPasskey } from '@/components/account/add-passkey';
import { SignOutButton } from '@/components/account/sign-out-button';

export const dynamic = 'force-dynamic';

export default async function StudentSettingsPage() {
  const session = await getSession();
  if (!session?.studentId) redirect('/login');

  const student = await prisma.student.findUnique({
    where: { id: session.studentId },
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

      <section className="mt-10 pt-6 border-t border-border">
        <h2 className="type-subtitle mb-3">Sign-in</h2>
        <AddPasskey />
        <div className="mt-5">
          <SignOutButton />
        </div>
      </section>

      <DataAndDeletion role="student" />
    </div>
  );
}
