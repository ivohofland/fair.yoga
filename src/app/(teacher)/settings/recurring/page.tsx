import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateList } from '@/components/settings/template-list';

export default async function RecurringClassesPage() {
  const session = await requireTeacherSession();

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.userId, isArchived: false },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader backHref="/settings" backLabel="Settings"
        title="Recurring classes"
        action={<Link href="/settings/recurring/new" className="type-label text-teal no-underline">+ Add</Link>}
      />
      <TemplateList templates={templates} />
      <div className="mt-6">
        <Link href="/settings/recurring/archived" className="type-caption no-underline">
          View archived recurring classes
        </Link>
      </div>
    </>
  );
}
