import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateList } from '@/components/settings/template-list';

export default async function ArchivedTemplatesPage() {
  const session = await requireTeacherSession();

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.teacherId, isArchived: true },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader title="Archived recurring classes" backHref="/settings/recurring" backLabel="Recurring classes" />
      <TemplateList templates={templates} emptyMessage="No archived recurring classes." />
    </>
  );
}
