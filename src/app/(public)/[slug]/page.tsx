import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { snippet } from '@/lib/seo';
import { getSession } from '@/lib/session';
import { StatusBadge } from '@/components/ui/status-badge';
import { RegistrationProgress } from '@/components/ui/registration-progress';
import { Icon } from '@/components/ui/icon';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar } from '@/components/ui/avatar';
import { formatDayHeader } from '@/lib/format';
import { locationLabel } from '@/lib/class-location';
import { timeToHHmm } from '@/lib/time-of-day';
import { ClassPriceLine } from '@/components/booking/price-range';
import { PricingExplainer } from '@/components/booking/pricing-explainer';
import { readIncomeTier } from '@/lib/tiers.server';
import { resolvePriceLine, type PriceLineViewer } from '@/lib/price-line';
import { listPublicSchedule, type PublicClassEntry } from '@/services/public-schedule';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

/**
 * Whether this page shows `teacher`; anything else is a 404. The body and its
 * metadata both ask, so the head never names a teacher the body hides.
 * `deletedAt` is checked on its own, not left to the slug.
 */
function isShown<T extends { deletedAt: Date | null }>(teacher: T | null): teacher is T {
  return teacher !== null && !teacher.deletedAt;
}

// Indexable: this page asks search engines nothing either way. No openGraph of
// its own, which would replace the inherited preview image; the card takes
// this title and description. Policy: docs/technical-architecture.md (Search engines).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const teacher = await prisma.teacher.findUnique({
    where: { pageSlug: slug },
    select: { firstName: true, lastName: true, bio: true, deletedAt: true },
  });
  if (!isShown(teacher)) return {};

  const name = `${teacher.firstName} ${teacher.lastName}`;
  return {
    title: name,
    description: teacher.bio ? snippet(teacher.bio) : `Book a class with ${name}.`,
    alternates: { canonical: `/${slug}` },
  };
}

// The teacher's public booking page: profile + upcoming open classes with
// honest per-tier price estimates. This is the teacher's own front door —
// calm, transparent, no marketing. The product's front door is `/`.
export default async function TeacherBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const teacher = await prisma.teacher.findUnique({
    where: { pageSlug: slug },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      bio: true,
      deletedAt: true,
      scheduleShareKey: true,
      defaultTimezone: true,
      photo: { select: { id: true } },
    },
  });
  if (!isShown(teacher)) notFound();

  // The service decides what is bookable: open, public, not cancelled, and not
  // yet started, by the teacher's calendar rather than UTC's.
  const schedule = await listPublicSchedule(prisma, {
    teacherId: teacher.id,
    timeZone: teacher.defaultTimezone,
    now: new Date(),
    mode: { kind: 'bookable', weeks: null },
    includeStudio: false,
  });
  const classes = schedule.filter((e): e is PublicClassEntry => e.kind === 'class');

  // A signed-in student's own state on these classes — everyone else
  // sees the cards unchanged.
  const session = await getSession();
  let bookedClassIds = new Set<string>();
  let waitingClassIds = new Set<string>();
  let viewer: PriceLineViewer | null = null;
  if (session?.studentId && classes.length > 0) {
    const classIds = classes.map((c) => c.id);
    const [own, waiting, student] = await Promise.all([
      prisma.registration.findMany({
        where: { studentId: session.studentId, classId: { in: classIds }, status: 'registered' },
        select: { classId: true },
      }),
      prisma.waitlistEntry.findMany({
        where: { studentId: session.studentId, classId: { in: classIds }, status: 'waiting' },
        select: { classId: true },
      }),
      prisma.student.findUnique({
        where: { id: session.studentId },
        select: { incomeTier: true, tierSelectedAt: true },
      }),
    ]);
    bookedClassIds = new Set(own.map((r) => r.classId));
    waitingClassIds = new Set(waiting.map((w) => w.classId));
    // A hard-delete racing this request between session validation and this
    // query — this is a public page, so it falls back to the signed-out
    // view of itself rather than 500ing a teacher's front door.
    if (!student) {
      log.warn(
        { studentId: session.studentId },
        'session.studentId has no matching Student row; falling back to signed-out view',
      );
    }
    viewer = student
      ? {
          studentId: session.studentId,
          tier: readIncomeTier(student.incomeTier, { studentId: session.studentId }),
          tierSelectedAt: student.tierSelectedAt,
        }
      : null;
  }

  return (
    <div>
      <div className="flex items-start gap-4">
        <Avatar firstName={teacher.firstName} lastName={teacher.lastName} photoId={teacher.photo?.id ?? null} size={72} />
        <div className="min-w-0">
          <h1 className="type-display">
            {teacher.firstName} {teacher.lastName}
          </h1>
          {teacher.bio && <p className="type-body mt-2 max-w-[480px]">{teacher.bio}</p>}
        </div>
      </div>

      <PricingExplainer className="mt-5 max-w-[480px]" />

      <h2 className="type-subtitle mt-8 mb-3">Upcoming classes</h2>

      {classes.length === 0 ? (
        <EmptyState
          title="No open classes right now"
          body="Check back soon — new classes appear here."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {classes.map((cls) => {
            const activeCount = cls.economics.registrations.filter((r) => r.status !== 'late_cancel').length;
            const isFull = activeCount >= cls.economics.maxStudents;

            return (
              <Link
                key={cls.id}
                href={`/${slug}/book/${cls.id}`}
                className="block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="type-label text-ink">
                    {formatDayHeader(cls.date)} · {timeToHHmm(cls.startTime)}
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
                  {locationLabel(cls.location)}
                  {' · '}{cls.durationMinutes} min
                </p>
                <RegistrationProgress
                  registered={activeCount}
                  min={cls.economics.minStudents}
                  max={cls.economics.maxStudents}
                  className="mt-3"
                />
                {(bookedClassIds.has(cls.id) || waitingClassIds.has(cls.id)) && (
                  <p className="type-label text-teal mt-2">
                    {bookedClassIds.has(cls.id) ? '✓ Booked' : 'On the waitlist'}
                  </p>
                )}
                <ClassPriceLine
                  line={resolvePriceLine({
                    pricingMode: cls.pricingMode,
                    roomCost: cls.economics.roomCost,
                    minRate: cls.economics.minRate,
                    targetRate: cls.economics.targetRate,
                    minStudents: cls.economics.minStudents,
                    maxStudents: cls.economics.maxStudents,
                    vatPercent: cls.economics.vatPercent,
                    registrations: cls.economics.registrations,
                    viewer,
                  })}
                  currency={cls.economics.currency}
                  className={bookedClassIds.has(cls.id) || waitingClassIds.has(cls.id) ? 'mt-1' : 'mt-2'}
                />
              </Link>
            );
          })}
        </div>
      )}

      {teacher.scheduleShareKey && (
        <p className="type-caption mt-6">
          <a href={`webcal://${new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').host}/feed/${teacher.scheduleShareKey}.ics`}>
            Subscribe to {teacher.firstName}&apos;s schedule
          </a>
        </p>
      )}
    </div>
  );
}
