import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ClassList } from '@/components/schedule/class-list';

export default async function SchedulePage() {
  const session = await requireTeacherSession();

  const classes = await prisma.class.findMany({
    where: { teacherId: session.userId },
    orderBy: { date: 'asc' },
    include: {
      _count: { select: { registrations: true } },
      teacherRoom: { include: { room: true } },
    },
  });

  return (
    <>
      <PageHeader title="Schedule" />
      <ClassList classes={classes} />
    </>
  );
}
