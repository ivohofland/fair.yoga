import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateList } from '@/components/settings/studio-template-list';

export default async function ArchivedStudioTemplatesPage() {
  const session = await requireTeacherSession();

  const templates = await prisma.studioClassTemplate.findMany({
    where: { teacherId: session.teacherId, isArchived: true },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader title="Archived studio classes" backHref="/settings/studio-classes" backLabel="Studio classes" />
      <StudioTemplateList templates={templates} emptyMessage="No archived studio classes." />
    </>
  );
}
