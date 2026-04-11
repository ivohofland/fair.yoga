import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ClassList } from '@/components/schedule/class-list';

export default async function PastClassesPage() {
  const session = await requireTeacherSession();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [classes, studioClasses] = await Promise.all([
    prisma.class.findMany({
      where: { teacherId: session.userId, date: { lt: today } },
      orderBy: { date: 'desc' },
      include: {
        _count: { select: { registrations: true } },
        teacherRoom: { include: { room: true } },
      },
    }),
    prisma.studioClass.findMany({
      where: { teacherId: session.userId, date: { lt: today } },
      orderBy: { date: 'desc' },
    }),
  ]);

  return (
    <>
      <PageHeader title="Past classes" backHref="/schedule" />
      <ClassList classes={classes} studioClasses={studioClasses} emptyMessage="No past classes." showAddLink={false} sortDesc />
    </>
  );
}
