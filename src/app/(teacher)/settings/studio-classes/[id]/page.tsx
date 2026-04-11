import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateForm } from '@/components/settings/studio-template-form';
import { ToggleStudioTemplateButton } from '@/components/settings/toggle-studio-template-button';
import { ArchiveStudioTemplateButton } from '@/components/settings/archive-studio-template-button';

export default async function EditStudioTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const template = await prisma.studioClassTemplate.findUnique({
    where: { id },
  });

  if (!template || template.teacherId !== session.userId) {
    redirect('/settings/studio-classes');
  }

  return (
    <>
      <PageHeader title={template.location} backHref="/settings/studio-classes" />

      <StudioTemplateForm
        mode="edit"
        templateId={template.id}
        initial={{
          dayOfWeek: template.dayOfWeek,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
          location: template.location,
          hourlyRate: Number(template.hourlyRate),
        }}
      />

      <section className="mt-8 pt-6 border-t border-border flex flex-col gap-4">
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
