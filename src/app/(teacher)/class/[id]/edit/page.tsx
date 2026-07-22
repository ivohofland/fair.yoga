import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { ClassEditForm } from '@/components/class/class-edit-form';

export const dynamic = 'force-dynamic';

export default async function ClassEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireTeacherSession();

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls || cls.teacherId !== session.teacherId) redirect('/');
  // Only mutable stages get an editor; everything else reads.
  if (cls.status !== 'draft' && cls.status !== 'open') redirect(`/class/${id}`);

  return (
    <div>
      <Link
        href={`/class/${id}`}
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        {cls.classType}
      </Link>
      <h1 className="type-title mb-6">Edit class</h1>
      <ClassEditForm
        classId={cls.id}
        settingsLocked={cls.settingsLocked}
        initial={{
          classType: cls.classType,
          description: cls.description ?? '',
          date: cls.date.toISOString().slice(0, 10),
          startTime: cls.startTime,
          durationMinutes: cls.durationMinutes,
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
