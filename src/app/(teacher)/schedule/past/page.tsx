import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ClassList } from '@/components/schedule/class-list';

export default async function PastClassesPage() {
  const session = await requireTeacherSession();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const classes = await prisma.class.findMany({
    where: { teacherId: session.userId, date: { lt: today } },
    orderBy: { date: 'desc' },
    include: {
      _count: { select: { registrations: true } },
      teacherRoom: { include: { room: true } },
    },
  });

  return (
    <>
      <PageHeader title="Past classes" backHref="/schedule" />
      <ClassList classes={classes} emptyMessage="No past classes." showAddLink={false} />
    </>
  );
}
