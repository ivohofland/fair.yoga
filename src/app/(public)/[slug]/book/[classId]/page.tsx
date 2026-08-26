import { notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { Icon } from '@/components/ui/icon';
import { estimateTierPrices, estimateAttendanceSpread } from '@/lib/tier-estimates';
import { formatRoomLocation, formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { PriceRange, PersonalPriceRange } from '@/components/booking/price-range';
import { BookingFlow } from '@/components/booking/booking-flow';
import { BookingSignIn } from '@/components/booking/booking-sign-in';
import { JoinAsStudent } from '@/components/booking/join-as-student';
import { toIncomeTier } from '@/lib/tiers.server';

export const dynamic = 'force-dynamic';

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
        select: { id: true, tierAtBooking: true, status: true, studentId: true },
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
    registeredTiers: cls.registrations.map((r) =>
      toIncomeTier(r.tierAtBooking, { registrationId: r.id }),
    ),
  });

  const session = await getSession();
  const student = session?.studentId
    ? await prisma.student.findUnique({
        where: { id: session.studentId },
        select: {
          id: true,
          firstName: true,
          incomeTier: true,
          tierSelectedAt: true,
        },
      })
    : null;
  // One conversion serves both the attendance-spread estimate and BookingFlow's
  // initial picker value — they read the same column. Carrying `student`
  // alongside its converted tier (rather than a standalone const) lets
  // narrowing `viewer` for truthiness also narrow `viewer.tier`, which
  // TypeScript could not do across two separate consts.
  const viewer = student
    ? { ...student, tier: toIncomeTier(student.incomeTier, { studentId: student.id }) }
    : null;
  // The viewer's own charged row, if any. They are already in the pool,
  // so the personal spread must quote them from that row — not append a
  // second copy of them ("+1 joining"). A late_cancel row also stays
  // out of the pool here: rebooking reactivates that same row, so the
  // viewer re-enters as themselves, not as an extra body.
  const ownRegistration = student
    ? (cls.registrations.find((r) => r.studentId === student.id) ?? null)
    : null;
  const alreadyBooked = ownRegistration !== null && ownRegistration.status !== 'late_cancel';
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
        {formatDayHeader(cls.date)} &middot; {timeToHHmm(cls.startTime)} &middot; {cls.durationMinutes} min
      </p>
      <p className="type-caption mt-0.5">
        {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
      </p>
      {viewer && viewer.tierSelectedAt ? (
        // Their tier is settled — turnout is the remaining uncertainty.
        <PersonalPriceRange
          spread={estimateAttendanceSpread({
            roomCost: Number(cls.roomCost),
            minRate: Number(cls.minRate),
            targetRate: Number(cls.targetRate),
            minStudents: cls.minStudents,
            maxStudents: cls.maxStudents,
            registeredTiers: cls.registrations
              .filter((r) => r !== ownRegistration)
              .map((r) => toIncomeTier(r.tierAtBooking, { registrationId: r.id })),
            // A booked viewer is billed at the tier stamped on their
            // registration; everyone else would join at their current one.
            viewerTier: alreadyBooked && ownRegistration
              ? toIncomeTier(ownRegistration.tierAtBooking, { registrationId: ownRegistration.id })
              : viewer.tier,
          })}
          className="mt-2 mb-6"
        />
      ) : (
        <PriceRange estimates={estimates} className="mt-2 mb-6" />
      )}

      {viewer ? (
        <BookingFlow
          classId={cls.id}
          slug={slug}
          isFull={isFull}
          alreadyBooked={alreadyBooked}
          currentTier={viewer.tier}
          studentId={viewer.id}
          tierPrices={estimates}
          // The income-selection moment belongs to the student: the picker
          // shows until they have chosen a tier themselves, no matter what
          // registrations teachers created on their behalf.
          isFirstBooking={viewer.tierSelectedAt === null}
        />
      ) : guestTeacher ? (
        <JoinAsStudent firstName={guestTeacher.firstName} />
      ) : (
        <BookingSignIn redirect={`/${slug}/book/${cls.id}`} />
      )}
    </div>
  );
}
