import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ProfileForm } from '@/components/settings/profile-form';
import { DataAndDeletion } from '@/components/account/data-and-deletion';
import { AddPasskey } from '@/components/account/add-passkey';

export default async function ProfilePage() {
  const session = await requireTeacherSession();

  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.userId },
  });

  return (
    <>
      <PageHeader title="Profile" backHref="/settings" backLabel="Settings" />
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

      <section className="mt-10 pt-6 border-t border-border">
        <h2 className="type-subtitle mb-3">Sign-in</h2>
        <AddPasskey />
      </section>

      <DataAndDeletion role="teacher" />
    </>
  );
}
