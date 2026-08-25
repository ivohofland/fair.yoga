import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateList } from '@/components/settings/template-list';
import { withSlot } from '@/services/class-template-lifecycle';

export default async function ArchivedTemplatesPage() {
  const session = await requireTeacherSession();

  const rows = await prisma.classTemplate.findMany({
    where: { scheduleRule: { teacherId: session.teacherId, isArchived: true } },
    include: { teacherRoom: { include: { room: true } }, scheduleRule: true },
    orderBy: { createdAt: 'desc' },
  });
  // `teacherRoom` re-attached explicitly: `withSlot`'s declared return type
  // is `ClassTemplateWithSlot`, which does not name it, so the spread below
  // would otherwise drop it from the STATIC type even though `bare` (and so
  // the runtime object) still carries it.
  const templates = rows.map(({ scheduleRule, ...bare }) => ({
    ...withSlot(bare, scheduleRule),
    teacherRoom: bare.teacherRoom,
  }));

  return (
    <>
      <PageHeader title="Archived recurring classes" backHref="/settings/recurring" backLabel="Recurring classes" />
      <TemplateList templates={templates} emptyMessage="No archived recurring classes." />
    </>
  );
}
