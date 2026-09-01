import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { StudioClassEditForm } from '@/components/studio-class/studio-class-edit-form';
import { studioClassEditability } from '@/services/studio-class-editability';
import { timeToHHmm } from '@/lib/time-of-day';

export const dynamic = 'force-dynamic';

export default async function StudioClassEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireTeacherSession();

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: { calendarEntry: true },
  });
  if (!studioClass || studioClass.calendarEntry.teacherId !== session.teacherId) redirect('/schedule');
  const entry = studioClass.calendarEntry;

  // Full-scope rows only. A fresh two-field literal, not `studioClass` — the
  // predicate is handed only what it may read, and passing the literal
  // directly keeps excess-property checking on. A past row is an income record
  // and has an editor nowhere; its page still reaches the count and the
  // cancellation.
  const verdict = studioClassEditability(
    { scheduleRuleId: entry.scheduleRuleId, date: entry.date },
    new Date(),
    session.defaultTimezone,
  );
  if (!verdict.scheduleEditable) redirect(`/studio-class/${id}`);

  return (
    <div>
      <Link
        href={`/studio-class/${id}`}
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        {entry.classType}
      </Link>
      <h1 className="type-title mb-6">Edit class</h1>
      <StudioClassEditForm
        studioClassId={studioClass.id}
        dateEditable={verdict.dateEditable}
        initial={{
          classType: entry.classType,
          location: studioClass.location,
          date: entry.date.toISOString().slice(0, 10),
          startTime: timeToHHmm(entry.startTime),
          durationMinutes: entry.durationMinutes,
          hourlyRate: Number(studioClass.hourlyRate),
        }}
      />
    </div>
  );
}
