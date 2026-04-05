import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateList } from '@/components/settings/template-list';

export default async function RecurringClassesPage() {
  const session = await requireTeacherSession();

  const templates = await prisma.classTemplate.findMany({
    where: { teacherId: session.userId },
    include: { teacherRoom: { include: { room: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return (
    <>
      <PageHeader
        title="Recurring classes"
        action={<Link href="/settings/recurring/new" className="text-teal text-sm">+ Add</Link>}
      />
      <TemplateList templates={templates} />
    </>
  );
}
