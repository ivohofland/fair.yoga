import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { TemplateList } from '@/components/settings/template-list';
import { withSlot } from '@/services/class-template-lifecycle';

export default async function RecurringClassesPage() {
  const session = await requireTeacherSession();

  const rows = await prisma.classTemplate.findMany({
    where: { scheduleRule: { teacherId: session.teacherId, isArchived: false } },
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
