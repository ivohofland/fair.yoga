import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateForm } from '@/components/settings/studio-template-form';
import { ToggleStudioTemplateButton } from '@/components/settings/toggle-studio-template-button';
import { ArchiveStudioTemplateButton } from '@/components/settings/archive-studio-template-button';
import { ArchivedRecord } from '@/components/settings/archived-record';

export default async function EditStudioTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const template = await prisma.studioClassTemplate.findUnique({
    where: { id },
    include: { teacher: true },
  });

  if (!template || template.teacherId !== session.teacherId) {
    redirect('/settings/studio-classes');
  }

  return (
    <>
      <PageHeader title={template.location} backHref="/settings/studio-classes" backLabel="Studio classes" />

      <StudioTemplateForm
        mode="edit"
        templateId={template.id}
        initial={{
          classType: template.classType,
          dayOfWeek: template.dayOfWeek,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
          location: template.location,
          hourlyRate: Number(template.hourlyRate),
        }}
      />

      <section className="mt-8 pt-6 border-t border-border flex flex-col gap-4">
        <ArchivedRecord
          archivedAt={template.archivedAt}
          withdrawnCount={template.withdrawnCount}
          timeZone={template.teacher.defaultTimezone}
        />
        {!template.isArchived && (
          <ToggleStudioTemplateButton templateId={template.id} isActive={template.isActive} />
        )}
        {!template.isActive && (
          <ArchiveStudioTemplateButton templateId={template.id} isArchived={template.isArchived} />
        )}
      </section>
    </>
  );
}
