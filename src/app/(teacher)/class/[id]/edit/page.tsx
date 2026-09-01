import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { ClassEditForm } from '@/components/class/class-edit-form';
import { timeToHHmm } from '@/lib/time-of-day';

export const dynamic = 'force-dynamic';

export default async function ClassEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireTeacherSession();

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: true },
  });
  if (!cls || cls.calendarEntry.teacherId !== session.teacherId) redirect('/schedule');
  // Only mutable stages get an editor; everything else reads. Since #327 that
  // is TWO reads, not one: a cancelled class keeps its `draft`/`open` status,
  // and `updateClass` refuses every field on it — an editor that still
  // rendered would be a form whose every save 409s.
  if (cls.calendarEntry.cancelledAt !== null) redirect(`/class/${id}`);
  if (cls.status !== 'draft' && cls.status !== 'open') redirect(`/class/${id}`);
  const entry = cls.calendarEntry;

  return (
    <div>
      <Link
        href={`/class/${id}`}
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        {entry.classType}
      </Link>
      <h1 className="type-title mb-6">Edit class</h1>
      <ClassEditForm
        classId={cls.id}
        settingsLocked={cls.settingsLocked}
        initial={{
          classType: entry.classType,
          description: cls.description ?? '',
          date: entry.date.toISOString().slice(0, 10),
          startTime: timeToHHmm(entry.startTime),
          durationMinutes: entry.durationMinutes,
          roomCost: Number(cls.roomCost),
          minRate: Number(cls.minRate),
          targetRate: Number(cls.targetRate),
          minStudents: cls.minStudents,
          maxStudents: cls.maxStudents,
        }}
      />
    </div>
  );
}
