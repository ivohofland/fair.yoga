import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateForm } from '@/components/settings/template-form';
import { ToggleTemplateButton } from '@/components/settings/toggle-template-button';
import { ArchiveTemplateButton } from '@/components/settings/archive-template-button';
import { ArchivedRecord } from '@/components/settings/archived-record';
import { timeToHHmm } from '@/lib/time-of-day';

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const template = await prisma.classTemplate.findUnique({
    where: { id },
    include: {
      teacherRoom: { include: { room: true } },
      scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } },
    },
  });

  if (!template || template.scheduleRule.teacherId !== session.teacherId) {
    redirect('/settings/recurring');
  }

  const { scheduleRule } = template;

  return (
    <>
      <PageHeader title={scheduleRule.classType} backHref="/settings/recurring" backLabel="Recurring classes" />

      <TemplateForm
        mode="edit"
        templateId={template.id}
        initial={{
          teacherRoomId: template.teacherRoomId,
          classType: scheduleRule.classType,
          description: template.description ?? '',
          dayOfWeek: scheduleRule.dayOfWeek,
          startTime: timeToHHmm(scheduleRule.startTime),
          durationMinutes: scheduleRule.durationMinutes,
          roomCost: Number(template.roomCost),
          minRate: Number(template.minRate),
          targetRate: Number(template.targetRate),
          minStudents: template.minStudents,
          maxStudents: template.maxStudents,
          cancelDeadline: template.cancelDeadline,
          autoCancelCheck: template.autoCancelCheck,
        }}
      />

      <section className="mt-8 pt-6 border-t border-border flex flex-col gap-4">
        <ArchivedRecord
          archivedAt={scheduleRule.archivedAt}
          withdrawnCount={scheduleRule.withdrawnCount}
          timeZone={scheduleRule.teacher.defaultTimezone}
        />
        {!scheduleRule.isArchived && (
          <ToggleTemplateButton templateId={template.id} isActive={scheduleRule.isActive} />
        )}
        {!scheduleRule.isActive && (
          <ArchiveTemplateButton templateId={template.id} isArchived={scheduleRule.isArchived} />
        )}
      </section>
    </>
  );
}
