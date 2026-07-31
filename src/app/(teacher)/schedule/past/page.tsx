import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ClassList } from '@/components/schedule/class-list';
import { startOfLocalDay } from '@/lib/timezone';

export default async function PastClassesPage() {
  const session = await requireTeacherSession();
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { defaultTimezone: true },
  });
  // #101. The teacher's calendar day, not UTC's. West of UTC in the local
  // evening, UTC has already rolled over, so a `setUTCHours(0,0,0,0)` boundary
  // is *tomorrow* by the teacher's calendar and lists a class they have not
  // taught yet as past.
  const today = startOfLocalDay(new Date(), teacher.defaultTimezone);

  const [classes, studioClasses] = await Promise.all([
    prisma.class.findMany({
      where: { teacherId: session.teacherId, date: { lt: today } },
      orderBy: { date: 'desc' },
      include: {
        _count: { select: { registrations: true } },
        // Payment statuses feed the completed-card rollup (✓ all paid …).
        registrations: {
          where: { status: { in: ['registered', 'attended', 'no_show', 'late_cancel'] } },
          select: { payment: { select: { status: true } } },
        },
        teacherRoom: { include: { room: true } },
      },
    }),
    prisma.studioClass.findMany({
      where: { teacherId: session.teacherId, date: { lt: today } },
      orderBy: { date: 'desc' },
    }),
  ]);

  return (
    <>
      <PageHeader title="Past classes" backHref="/schedule" backLabel="Schedule" />
      <ClassList classes={classes} studioClasses={studioClasses} timeZone={teacher.defaultTimezone} emptyMessage="No past classes." showAddLink={false} sortDesc />
    </>
  );
}
