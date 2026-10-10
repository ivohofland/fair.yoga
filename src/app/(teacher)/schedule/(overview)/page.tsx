import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { ClassList } from '@/components/schedule/class-list';
import { GettingStarted } from '@/components/schedule/getting-started';
import { InstallCard } from '@/components/schedule/install-card';
import { PushCard } from '@/components/schedule/push-card';
import { PaymentsPausedCard } from '@/components/schedule/payments-paused-card';
import { ScheduleHeader } from '@/components/schedule/schedule-header';
import { isOnboardingComplete } from '@/lib/onboarding';
import { hasPayoutDetails } from '@/lib/payment-methods';
import { readVapidConfig } from '@/lib/push/config';
import { startOfLocalWeek, startOfLocalDay } from '@/lib/timezone';
import { formatDayHeader } from '@/lib/format';
import { OfflineSnapshot } from '@/components/layout/offline-snapshot';
import { offlineSnapshotStamp, todaysOfflinePaths } from '@/lib/offline-snapshot-props';

/**
 * The home window: the current week so far (completed classes stay in
 * view for payments) plus four weeks ahead — matching how far recurring
 * templates generate. A strict this-week view hid every newly created
 * class until its week arrived.
 */
function getScheduleWindow(timeZone: string): { start: Date; end: Date } {
  const now = new Date();
  const start = startOfLocalWeek(now, timeZone);
  const end = startOfLocalDay(now, timeZone);
  end.setUTCDate(end.getUTCDate() + 28);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

// The Schedule tab is the home base: this week plus the coming four
// weeks as cards. Students, Inbox, and Settings live in their own tabs.
export default async function SchedulePage() {
  const session = await requireTeacherSession();
  const { start, end } = getScheduleWindow(session.defaultTimezone);
  const now = new Date();

  const [teacher, classes, studioClasses, roomCount, classCount] = await Promise.all([
    prisma.teacher.findUniqueOrThrow({
      where: { id: session.teacherId },
      select: {
        bio: true,
        currency: true,
        paymentLink: true,
        paymentsPausedAt: true,
        bankAccounts: { select: { currency: true } },
        skippedOnboarding: true,
        pageSlug: true,
        firstName: true,
        lastName: true,
        photo: { select: { id: true } },
      },
    }),
    prisma.class.findMany({
      where: {
        calendarEntry: { teacherId: session.teacherId, date: { gte: start, lt: end } },
      },
      orderBy: { calendarEntry: { date: 'asc' } },
      include: {
        calendarEntry: true,
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
      where: {
        calendarEntry: { teacherId: session.teacherId, date: { gte: start, lt: end } },
      },
      include: { calendarEntry: true },
      orderBy: { calendarEntry: { date: 'asc' } },
    }),
    prisma.teacherRoom.count({ where: { teacherId: session.teacherId, isArchived: false } }),
    prisma.class.count({ where: { calendarEntry: { teacherId: session.teacherId } } }),
  ]);

  const onboardingInput = {
    bio: teacher.bio,
    payoutDetailsSet: hasPayoutDetails(teacher),
    roomCount,
    classCount,
    skipped: teacher.skippedOnboarding,
  };

  const stamp = offlineSnapshotStamp(session, now);

  return (
    <OfflineSnapshot {...stamp} warmPaths={todaysOfflinePaths(classes, studioClasses, stamp.loadedOn)}>
    <div>
      <ScheduleHeader
        firstName={teacher.firstName}
        lastName={teacher.lastName}
        photoId={teacher.photo?.id ?? null}
        today={formatDayHeader(startOfLocalDay(now, session.defaultTimezone))}
      />

      {teacher.paymentsPausedAt !== null && <PaymentsPausedCard />}

      <InstallCard dismissed={teacher.skippedOnboarding.includes('install')} />

      <PushCard
        dismissed={teacher.skippedOnboarding.includes('push')}
        vapidPublicKey={readVapidConfig()?.publicKey ?? null}
      />

      {!isOnboardingComplete(onboardingInput) && (
        <GettingStarted {...onboardingInput} pageSlug={teacher.pageSlug} />
      )}

      <div data-layout-anchor="first-item">
        <ClassList
          classes={classes}
          studioClasses={studioClasses}
          timeZone={session.defaultTimezone}
          emptyMessage="No classes this week"
          showAddLink={false}
          dimPast
        />
      </div>

      <div className="flex flex-col items-start gap-3 mt-8">
        <Link href="/studio-class/new" className="inline-flex items-center min-h-11 type-label text-teal no-underline">
          Log a studio class
        </Link>
        <Link href="/schedule/past" className="inline-flex items-center min-h-11 type-label text-teal no-underline">
          View past classes
        </Link>
      </div>
    </div>
    </OfflineSnapshot>
  );
}
