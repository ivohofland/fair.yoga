import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { teacherVisibleName, studentNameSelect } from '@/lib/student-visibility';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { ClassInfo } from '@/components/class/class-info';
import { PricingPreview } from '@/components/class/pricing-preview';
import { AttendanceList } from '@/components/class/attendance-list';
import { PricingBreakdown } from '@/components/class/pricing-breakdown';
import { PaymentChecklist } from '@/components/class/payment-checklist';
import { PublishClassButton } from '@/components/class/publish-class-button';
import { CompleteClassButton } from '@/components/class/complete-class-button';
import type { AttendanceItem } from '@/components/class/attendance-list';
import type { PaymentItem } from '@/components/class/payment-checklist';
import { classStartInstant } from '@/lib/timezone';
import { CancelClassButton } from '@/components/class/cancel-class-button';
import { ShareBookingLink } from '@/components/class/share-booking-link';
import { AddWalkIn } from '@/components/class/add-walk-in';
import { SendAnnouncement } from '@/components/class/send-announcement';
import { toIncomeTier } from '@/lib/tiers.server';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { CLAIMABLE_WAITLIST_STATUSES } from '@/lib/waitlist-status';

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;
  // eslint-disable-next-line react-hooks/purity -- server component, Date.now() is fine
  const now = Date.now();

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      calendarEntry: {
        include: { teacher: { select: { defaultTimezone: true, pageSlug: true } } },
      },
      teacherRoom: { include: { room: true } },
      registrations: {
        include: {
          student: { select: studentNameSelect(session.teacherId) },
          payment: true,
        },
        orderBy: { registeredAt: 'asc' },
      },
      // #199. Unfiltered, this counted every `WaitlistStatus` value.
      // `promoted` and `claimed` rows carry a `Registration` written in the
      // same transaction that closed the entry — `promoteNext` (`waitlist.ts`,
      // via `activateRegistration`, linked at the entry update), `claimSpot`,
      // and a student booking directly while queued
      // (`api/registrations/route.ts`) — so for as long as that registration
      // stays active those students are in the registrations list on this page
      // too, counted twice. `removed` keeps counting everyone who left,
      // including every queue #195 closed.
      //
      // The class side of the same defect is handled in `class-info.tsx`,
      // which stops rendering the count once the class can no longer consume
      // its queue. Filtering here cannot do that: a relation `_count` filters
      // the related rows, not the parent's status.
      //
      // Stays `waiting`-only: this is the count for a LIVE queue, and folding
      // `expired` in here would inflate an open class's. The `in_progress` case
      // needs a different set and is read separately below, because a relation
      // `_count` cannot vary with the parent's own status.
      _count: { select: { waitlistEntries: { where: { status: 'waiting' } } } },
    },
  });

  if (!cls || cls.calendarEntry.teacherId !== session.teacherId) {
    redirect('/schedule');
  }

  // Read once, beside the status, because since #327 the two together are what
  // liveness is: a cancelled class keeps whatever status it had, so every
  // `status === 'open'` branch below would otherwise render a cancelled class
  // as bookable.
  const cancelled = cls.calendarEntry.cancelledAt !== null;

  // Two different questions, so two different reads.
  //
  // While `open`, the number that matters is who is still queuing. While
  // `in_progress`, it is who the teacher can still walk in at the door —
  // `CLAIMABLE_WAITLIST_STATUSES`, because `closeQueueOnStart` (#216) has
  // already flipped every `waiting` row to `expired` by then. Get that wrong and
  // this reads 0 beside the **Add walk-in** button that consumes exactly those
  // entries; this page and `api/registrations/route.ts` are the two sites that
  // must agree on that set, which is why it has a name rather than being
  // spelled out at each.
  //
  // REPLACES the `_count` rather than adding to it, so there is no double-count
  // to reason about: `addToWaitlist` requires `status === 'open'`, so an
  // `in_progress` class has no `waiting` rows this would miss.
  const waitlistCount =
    !cancelled && cls.status === 'in_progress'
      ? await prisma.waitlistEntry.count({
          where: { classId: cls.id, status: { in: [...CLAIMABLE_WAITLIST_STATUSES] } },
        })
      : cls._count.waitlistEntries;

  const activeRegistrations = cls.registrations.filter((r) => r.status !== 'cancelled');

  // Seat occupancy excludes late_cancel: those students are still charged
  // (they stay in activeRegistrations for attendance/payments) but their
  // seat is free — the booking page sells it, so the count here must agree.
  const seatCount = cls.registrations.filter((r) =>
    ACTIVE_REGISTRATION_STATUSES.includes(r.status),
  ).length;

  // Serialize registrations for client components (Prisma Dates/Decimals are not serializable)
  const attendanceItems: AttendanceItem[] = activeRegistrations
    .map((r) => ({
      registrationId: r.id,
      studentName: teacherVisibleName(r.student, session.teacherId),
      status: r.status,
    }));

  const paymentItems: PaymentItem[] = cls.registrations
    .filter((r) => r.status !== 'cancelled' && r.payment)
    .map((r) => ({
      paymentId: r.payment!.id,
      studentId: r.studentId,
      studentName: teacherVisibleName(r.student, session.teacherId),
      amount: Number(r.payment!.amount),
      status: r.payment!.status,
      reminderSentAt: r.payment!.reminderSentAt,
    }));

  // Actual tier prices for completed class pricing breakdown
  const tierPrices = activeRegistrations
    .filter((r) => r.price !== null)
    .map((r) => ({
      tier: toIncomeTier(r.tierAtBooking, { registrationId: r.id }),
      price: Number(r.price),
    }));

  // Check-in available: in_progress, or open within 15 min of start
  // (class start resolved in the teacher's timezone)
  //
  // This expression IS the gap issue #234 is about:
  // `autoCompleteClasses` flips a class to `completed`
  // within 60 seconds of its scheduled end, `showCheckin` goes false the
  // moment that happens, and `AttendanceList` below stops rendering — so a
  // teacher mid-checklist loses the ability to finish it about a minute
  // after the class ends, every class. The PUT route's guard
  // (`registrations/[id]/route.ts`) keeps `completed` writable precisely so
  // that gap can be closed without a lock-discipline change; this line is
  // where the UI fix has to start.
  const classStart = classStartInstant(
    cls.calendarEntry,
    cls.calendarEntry.teacher.defaultTimezone,
  );
  const minutesToStart = (classStart.getTime() - now) / 60_000;
  const showCheckin = !cancelled
    && (cls.status === 'in_progress' || (cls.status === 'open' && minutesToStart <= 15));

  return (
    <>
      <PageHeader
        title={cls.calendarEntry.classType}
        backHref="/" backLabel="Schedule"
        action={
          !cancelled && cls.status === 'draft'
            ? <PublishClassButton classId={cls.id} />
            : showCheckin
              ? <CompleteClassButton classId={cls.id} />
              : undefined
        }
      />
      <ClassInfo
        cls={cls}
        registrationCount={seatCount}
        waitlistCount={waitlistCount}
      />

      {/* Check-in mode: attendance checklist + walk-ins + pricing estimate */}
      {showCheckin && (
        <>
          <AttendanceList items={attendanceItems} />
          <div className="py-2">
            <AddWalkIn
              classId={cls.id}
              registeredStudentIds={activeRegistrations.map((r) => r.studentId)}
            />
          </div>
          <PricingPreview cls={cls} />
        </>
      )}

      {/* Open (not yet check-in): registered students + pricing preview */}
      {!cancelled && cls.status === 'open' && !showCheckin && activeRegistrations.length > 0 && (
        <div className="py-6">
          <h2 className="type-subtitle mb-1">Registered students</h2>
          <div>
            {activeRegistrations.map((r) => (
              <Link
                key={r.id}
                href={`/students/${r.studentId}`}
                className="flex items-center min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
              >
                <span className="text-base text-ink">{teacherVisibleName(r.student, session.teacherId)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Draft: pricing preview */}
      {!cancelled && cls.status === 'draft' && (
        <PricingPreview cls={cls} />
      )}

      {/* Open (not check-in): pricing preview */}
      {!cancelled && cls.status === 'open' && !showCheckin && (
        <PricingPreview cls={cls} />
      )}

      {/* Completed: Show pricing breakdown + payment checklist */}
      {!cancelled && cls.status === 'completed' && (
        <>
          <PricingBreakdown cls={cls} tierPrices={tierPrices} />
          <PaymentChecklist items={paymentItems} />
        </>
      )}

      {/* Cancelled */}
      {cancelled && (
        <div className="py-8 text-center type-body">
          This class was cancelled.
        </div>
      )}

      {/* Actions: share while bookable, announce while it has students, cancel while upcoming */}
      {!cancelled && (
        <div className="mt-8 pt-6 border-t border-border flex flex-col items-start gap-5">
          {cls.status === 'open' && (
            <ShareBookingLink pageSlug={cls.calendarEntry.teacher.pageSlug} />
          )}
          {activeRegistrations.length > 0 && (
            <SendAnnouncement classId={cls.id} recipientHint="everyone in this class" />
          )}
          {(cls.status === 'draft' || cls.status === 'open') && (
            <>
              <Link
                href={`/class/${cls.id}/edit`}
                className="type-label text-teal no-underline"
              >
                Edit class
              </Link>
              <CancelClassButton classId={cls.id} registrationCount={activeRegistrations.length} />
            </>
          )}
        </div>
      )}
    </>
  );
}
