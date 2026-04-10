import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateForm } from '@/components/settings/template-form';
import { ToggleTemplateButton } from '@/components/settings/toggle-template-button';
import { ArchiveTemplateButton } from '@/components/settings/archive-template-button';

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const template = await prisma.classTemplate.findUnique({
    where: { id },
    include: { teacherRoom: { include: { room: true } } },
  });

  if (!template || template.teacherId !== session.userId) {
    redirect('/settings/recurring');
  }

  return (
    <>
      <PageHeader title={template.classType} backHref="/settings/recurring" />

      <TemplateForm
        mode="edit"
        templateId={template.id}
        initial={{
          teacherRoomId: template.teacherRoomId,
          classType: template.classType,
          description: template.description ?? '',
          dayOfWeek: template.dayOfWeek,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
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
        {!template.isArchived && (
          <ToggleTemplateButton templateId={template.id} isActive={template.isActive} />
        )}
        {!template.isActive && (
          <ArchiveTemplateButton templateId={template.id} isArchived={template.isArchived} />
        )}
      </section>
    </>
  );
}
