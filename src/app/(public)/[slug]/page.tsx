import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { StatusBadge } from '@/components/ui/status-badge';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { estimateTierPrices } from '@/lib/tier-estimates';
import { formatRoomLocation } from '@/lib/format';

export const dynamic = 'force-dynamic';

function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// The teacher's public booking page: profile + upcoming open classes with
// honest per-tier price estimates. This is the front door of the whole
// product — calm, transparent, no marketing.
export default async function TeacherBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const teacher = await prisma.teacher.findUnique({
    where: { pageSlug: slug },
    select: { id: true, firstName: true, lastName: true, bio: true, deletedAt: true },
  });
  // deletedAt: erasure renames the slug, but never rely on that alone.
  if (!teacher || teacher.deletedAt) notFound();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const classes = await prisma.class.findMany({
    where: { teacherId: teacher.id, status: 'open', date: { gte: today } },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
    include: {
      teacherRoom: { include: { room: true } },
      registrations: {
        where: { status: { in: ['registered', 'attended', 'no_show', 'late_cancel'] } },
        select: { tierAtBooking: true, status: true },
      },
    },
  });

  return (
    <div>
      <h1 className="type-display">
        {teacher.firstName} {teacher.lastName}
      </h1>
      {teacher.bio && <p className="type-body mt-2 max-w-[480px]">{teacher.bio}</p>}

      <h2 className="type-subtitle mt-8 mb-3">Upcoming classes</h2>

      {classes.length === 0 ? (
        <EmptyState
          title="No open classes right now"
          body="Check back soon — new classes appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {classes.map((cls) => {
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
            const low = Math.min(...estimates);
            const high = Math.max(...estimates);

            return (
              <Link
                key={cls.id}
                href={`/${slug}/book/${cls.id}`}
                className="block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="type-label text-ink">
                    {formatDayHeader(cls.date)} · {cls.startTime}
                  </span>
                  <StatusBadge variant={isFull ? 'full' : 'registering'}>
                    {isFull ? 'Full — join the waitlist' : 'Open'}
                  </StatusBadge>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  <span className="type-subtitle flex-1 min-w-0">{cls.classType}</span>
                  <Icon name="chevron-right" size={20} className="text-brown-light" />
                </div>
                <p className="type-caption mt-0.5">
                  {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
                  {' · '}{cls.durationMinutes} min
                </p>
                <RegistrationProgress
                  registered={activeCount}
                  min={cls.minStudents}
                  max={cls.maxStudents}
                  className="mt-3"
                />
                <p className="type-caption mt-2">
                  Your price:{' '}
                  <span className="type-number text-[13px]">
                    €{low.toFixed(2)} – €{high.toFixed(2)}
                  </span>{' '}
                  depending on your income tier
                </p>
              </Link>
            );
          })}
        </div>
      )}

      <p className="type-caption mt-8 max-w-[420px]">
        Prices are income-based: everyone in the room pays what fits their
        situation, and the final price settles after class based on who came.
        The highest tier never pays more than about twice the lowest.
      </p>
    </div>
  );
}
