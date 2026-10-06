import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { timeZoneOptions } from '@/lib/timezone-options';
import { PageHeader } from '@/components/layout/page-header';
import { ProfileForm } from '@/components/settings/profile-form';
import { ProfilePhotoField } from '@/components/settings/profile-photo-field';
import { DataAndDeletion } from '@/components/account/data-and-deletion';
import { AddPasskey } from '@/components/account/add-passkey';

export default async function ProfilePage() {
  const session = await requireTeacherSession();

  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    include: { photo: { select: { id: true } } },
  });

  return (
    <>
      <PageHeader title="Profile" backHref="/settings" backLabel="Settings" />
      <ProfilePhotoField
        teacherId={teacher.id}
        firstName={teacher.firstName}
        lastName={teacher.lastName}
        photoId={teacher.photo?.id ?? null}
      />
      <ProfileForm
        teacherId={teacher.id}
        email={teacher.email}
        timeZoneOptions={timeZoneOptions(teacher.defaultTimezone, new Date())}
        initial={{
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          bio: teacher.bio,
          pageSlug: teacher.pageSlug,
          currency: teacher.currency,
          defaultTimezone: teacher.defaultTimezone,
          bankIban: teacher.bankIban,
          bankAccountName: teacher.bankAccountName,
        }}
      />

      <section className="mt-10 pt-6 border-t border-border">
        <h2 className="type-subtitle mb-3">Sign-in</h2>
        <AddPasskey />
      </section>

      <DataAndDeletion role="teacher" accountId={session.accountId} />
    </>
  );
}
