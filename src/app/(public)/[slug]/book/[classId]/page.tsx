import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { estimateTierPrices } from '@/lib/tier-estimates';
import { formatRoomLocation } from '@/lib/format';
import { PriceRange } from '@/components/booking/price-range';
import { BookingFlow } from '@/components/booking/booking-flow';
import { BookingSignIn } from '@/components/booking/booking-sign-in';
import { JoinAsStudent } from '@/components/booking/join-as-student';

export const dynamic = 'force-dynamic';

function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Tier selection + confirmation — the most philosophically important screen.
export default async function BookClassPage({
  params,
}: {
  params: Promise<{ slug: string; classId: string }>;
}) {
  const { slug, classId } = await params;

  const cls = await prisma.class.findUnique({
    where: { id: classId },
    include: {
      teacher: {
        select: { id: true, firstName: true, lastName: true, pageSlug: true, deletedAt: true },
      },
      teacherRoom: { include: { room: true } },
      registrations: {
        where: { status: { in: ['registered', 'attended', 'no_show', 'late_cancel'] } },
        select: { tierAtBooking: true, status: true, studentId: true },
      },
    },
  });

  // deletedAt: erasure renames the slug, but never rely on that alone.
  if (!cls || cls.teacher.pageSlug !== slug || cls.teacher.deletedAt || cls.status !== 'open') {
    notFound();
  }

  const activeCount = cls.registrations.filter((r) => r.status !== 'late_cancel').length;
  const isFull = activeCount >= cls.maxStudents;
  const estimates = estimateTierPrices({
    roomCost: Number(cls.roomCost),
    minRate: Number(cls.minRate),
    targetRate: Number(cls.targetRate),
    minStudents: cls.minStudents,
    maxStudents: cls.maxStudents,
    registeredTiers: cls.registrations.map((r) => r.tierAtBooking),
  });

  const session = await getSession();
  const student = session?.studentId
    ? await prisma.student.findUnique({
        where: { id: session.studentId },
        select: { id: true, firstName: true, incomeTier: true },
      })
    : null;
  const alreadyBooked = student
    ? cls.registrations.some((r) => r.studentId === student.id && r.status !== 'late_cancel')
    : false;
  // A signed-in teacher without a student side gets the join panel, not a
  // sign-in form they can't use.
  const guestTeacher =
    !student && session?.teacherId
      ? await prisma.teacher.findUnique({
          where: { id: session.teacherId },
          select: { firstName: true },
        })
      : null;

  return (
    <div>
      <Link
        href={`/${slug}`}
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        {cls.teacher.firstName} {cls.teacher.lastName}
      </Link>
      <h1 className="type-title">{cls.classType}</h1>
      <p className="type-body mt-1">
        {formatDayHeader(cls.date)} &middot; {cls.startTime} &middot; {cls.durationMinutes} min
      </p>
      <p className="type-caption mt-0.5">
        {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
      </p>
      <PriceRange estimates={estimates} className="mt-2 mb-6" />

      {student ? (
        <BookingFlow
          classId={cls.id}
          slug={slug}
          isFull={isFull}
          alreadyBooked={alreadyBooked}
          currentTier={student.incomeTier}
          studentId={student.id}
          tierPrices={estimates}
        />
      ) : guestTeacher ? (
        <JoinAsStudent firstName={guestTeacher.firstName} />
      ) : (
        <BookingSignIn redirect={`/${slug}/book/${cls.id}`} />
      )}
    </div>
  );
}
