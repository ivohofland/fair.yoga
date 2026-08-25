import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateList } from '@/components/settings/studio-template-list';
import { withSlot } from '@/services/studio-class-template-lifecycle';

export default async function ArchivedStudioTemplatesPage() {
  const session = await requireTeacherSession();

  const rows = await prisma.studioClassTemplate.findMany({
    where: { scheduleRule: { teacherId: session.teacherId, isArchived: true } },
    include: { scheduleRule: true },
    orderBy: { createdAt: 'desc' },
  });
  const templates = rows.map(({ scheduleRule, ...bare }) => withSlot(bare, scheduleRule));

  return (
    <>
      <PageHeader title="Archived studio classes" backHref="/settings/studio-classes" backLabel="Studio classes" />
      <StudioTemplateList templates={templates} emptyMessage="No archived studio classes." />
    </>
  );
}
