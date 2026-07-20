import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { StudioTemplateList } from '@/components/settings/studio-template-list';

export default async function StudioClassesPage() {
  const session = await requireTeacherSession();

  const templates = await prisma.studioClassTemplate.findMany({
    where: { teacherId: session.teacherId, isArchived: false },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader backHref="/settings" backLabel="Settings"
        title="Studio classes"
        action={<Link href="/settings/studio-classes/new" className="type-label text-teal no-underline">+ Add</Link>}
      />
      <StudioTemplateList templates={templates} />
      <div className="mt-6">
        <Link href="/settings/studio-classes/archived" className="type-caption no-underline">
          View archived studio classes
        </Link>
      </div>
    </>
  );
}
