import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateForm, type StudioTemplateFormValues } from '@/components/settings/studio-template-form';
import { ToggleStudioTemplateButton } from '@/components/settings/toggle-studio-template-button';
import { ArchiveStudioTemplateButton } from '@/components/settings/archive-studio-template-button';
import { ArchivedRecord } from '@/components/settings/archived-record';
import { timeToHHmm } from '@/lib/time-of-day';

export default async function EditStudioTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const template = await prisma.studioClassTemplate.findUnique({
    where: { id },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });

  if (!template || template.scheduleRule.teacherId !== session.teacherId) {
    redirect('/settings/studio-classes');
  }

  const { scheduleRule } = template;

  const initial: StudioTemplateFormValues = {
    classType: scheduleRule.classType,
    dayOfWeek: scheduleRule.dayOfWeek,
    startTime: timeToHHmm(scheduleRule.startTime),
    durationMinutes: scheduleRule.durationMinutes,
    location: template.location,
    hourlyRate: Number(template.hourlyRate),
  };

  return (
    <>
      <PageHeader
        title={scheduleRule.classType || template.location}
        backHref="/settings/studio-classes"
        backLabel="Studio classes"
      />

      <StudioTemplateForm
        mode="edit"
        templateId={template.id}
        initial={initial}
      />

      <section className="mt-8 pt-6 border-t border-border flex flex-col gap-4">
        <ArchivedRecord
          archivedAt={scheduleRule.archivedAt}
          withdrawnCount={scheduleRule.withdrawnCount}
          timeZone={scheduleRule.teacher.defaultTimezone}
        />
        {!scheduleRule.isArchived && (
          <ToggleStudioTemplateButton templateId={template.id} isActive={scheduleRule.isActive} />
        )}
        {!scheduleRule.isActive && (
          <ArchiveStudioTemplateButton templateId={template.id} isArchived={scheduleRule.isArchived} />
        )}
      </section>
    </>
  );
}
