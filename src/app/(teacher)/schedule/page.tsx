import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { ClassList } from '@/components/schedule/class-list';

export default async function SchedulePage() {
  const session = await requireTeacherSession();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const classes = await prisma.class.findMany({
    where: { teacherId: session.userId, date: { gte: today } },
    orderBy: { date: 'asc' },
    include: {
      _count: { select: { registrations: true } },
      teacherRoom: { include: { room: true } },
    },
  });

  return (
    <>
      <PageHeader title="Schedule" action={<Link href="/class/new" className="text-teal text-sm">+ Add class</Link>} />
      <ClassList classes={classes} emptyMessage="No upcoming classes." showAddLink={false} />
      <div className="mt-6">
        <Link href="/schedule/past" className="text-brown text-sm opacity-60">
          View past classes
        </Link>
      </div>
    </>
  );
}
