import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ProfileForm } from '@/components/settings/profile-form';

export default async function ProfilePage() {
  const session = await requireTeacherSession();

  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.userId },
  });

  return (
    <>
      <PageHeader title="Profile" />
      <ProfileForm
        teacherId={teacher.id}
        initial={{
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          email: teacher.email,
          bio: teacher.bio,
          pageSlug: teacher.pageSlug,
          defaultCurrency: teacher.defaultCurrency,
          defaultTimezone: teacher.defaultTimezone,
          defaultReminder: teacher.defaultReminder,
          bankIban: teacher.bankIban,
          bankAccountName: teacher.bankAccountName,
        }}
      />
    </>
  );
}
