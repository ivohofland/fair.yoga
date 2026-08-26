import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { StatusBadge, deriveBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { CancelBookingButton } from '@/components/student/cancel-booking-button';
import { UpdatesStrip } from '@/components/student/updates-strip';
import { WaitlistEntryActions } from '@/components/student/waitlist-entry-actions';
import { PaymentQr } from '@/components/student/payment-qr';
import { formatRoomLocation, paymentStateText, formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { getWaitlistWindow } from '@/services/waitlist';
import { studentNotificationHref } from '@/lib/notification-links';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';

export const dynamic = 'force-dynamic';

// The student's home: upcoming bookings, waitlist spots, past classes with
// what to pay and where. No engagement tricks — a quiet ledger.
export default async function StudentBookingsPage() {
  const session = await getSession();
  if (!session?.studentId) redirect(session?.teacherId ? '/' : '/login');

  const [registrations, waitlistEntries, unreadNotifications, notificationCount] = await Promise.all([
    prisma.registration.findMany({
      where: { studentId: session.studentId, status: { not: 'cancelled' } },
      orderBy: { class: { calendarEntry: { date: 'desc' } } },
      include: {
        class: {
          include: {
            calendarEntry: {
              include: {
                teacher: {
                  select: {
                    firstName: true,
                    lastName: true,
                    pageSlug: true,
                    bankIban: true,
                    bankAccountName: true,
                  },
                },
              },
            },
            teacherRoom: { include: { room: true } },
            _count: { select: { registrations: true } },
          },
        },
        payment: true,
      },
    }),
    prisma.waitlistEntry.findMany({
      // #199. The entry's own status is not enough on its own: `closeQueueOnStart`
      // (#216) now closes the queue the moment a class leaves `open` by
      // starting, but this predicate still earns its place — it guards
      // pre-existing rows from before #216 shipped, and it is belt-and-braces
      // against any future path that moves a class out of `open` without
      // going through the three call sites #216 covers. Positive, not
      // `not: 'cancelled'` — `open` is the predicate `addToWaitlist`,
      // `promoteNext`, `claimSpot` and `handleSpotFreed` all already require,
      // and a negative predicate would need extending for every terminal
      // state added later.
      //
      // `open` covers a full class: CLAUDE.md describes the lifecycle as
      // `open → full → in_progress`, but `ClassStatus` has no `full` — a class
      // at `maxStudents` is still `open`, and fullness is derived from counts
      // (`status-badge.tsx`). This predicate therefore hides no legitimate
      // queue, which is the one thing it would be fatal to get wrong: a queue
      // only forms once a class fills.
      //
      // One guard deliberately does NOT require `open`, and hiding the row
      // here is now the second of two defences rather than the only one.
      // `removeFromWaitlist` (sole call site `waitlist-entry-actions.tsx`)
      // scopes its write to `status: 'waiting'`, so a DELETE sent from a
      // stale render of this page — the class has since started and
      // `closeQueueOnStart` has already flipped the row to `expired` — is
      // refused as `NOT_FOUND` rather than overwriting it to `removed`, which
      // would turn "never got in" into "withdrew". This predicate keeps the
      // stale click from being offered; that guard is what makes it harmless
      // when it happens anyway, and the route answers it with a 409 and a
      // refresh rather than claiming the entry does not exist.
      //
      // Four drains now close a queue: `closeQueueOnStart` (#216, the class
      // starting) and the three cancel paths (#195).
      // `cancelledAt: null` beside the class's status (#327): a cancelled
      // class keeps its `open` status, and a queue on a cancelled class is
      // exactly what this predicate exists to hide.
      where: {
        studentId: session.studentId,
        status: 'waiting',
        class: { status: 'open', calendarEntry: { cancelledAt: null } },
      },
      include: {
        class: {
          include: {
            calendarEntry: {
              include: {
                teacher: {
                  select: {
                    firstName: true,
                    lastName: true,
                    pageSlug: true,
                    defaultTimezone: true,
                  },
                },
              },
            },
            _count: {
              select: {
                registrations: {
                  where: { status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
                },
              },
            },
          },
        },
      },
    }),
    prisma.notification.findMany({
      where: { recipientType: 'student', recipientId: session.studentId, isRead: false },
      // Id tie-breaker: announcements are batch-inserted with identical
      // timestamps and would otherwise shuffle between refreshes (008acbc).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 5,
      include: {
        relatedClass: {
          select: {
            id: true,
            status: true,
            calendarEntry: {
              select: { cancelledAt: true, teacher: { select: { pageSlug: true } } },
            },
          },
        },
      },
    }),
    prisma.notification.count({
      where: { recipientType: 'student', recipientId: session.studentId },
    }),
  ]);

  // Same targets /updates uses — see `studentNotificationHref`.
  const updates = unreadNotifications.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    createdAt: n.createdAt.toISOString(),
    href: studentNotificationHref(n),
  }));

  const now = new Date();
  // `cancelledAt` is NOT a filter here, deliberately: this splits the ledger
  // into upcoming and past, and a cancelled class the student is registered
  // for still belongs in whichever half its date puts it in. The badge below
  // is what says it is off.
  const upcoming = registrations.filter(
    (r) => r.class.status === 'open'
      || r.class.status === 'in_progress'
      || new Date(r.class.calendarEntry.date) >= now,
  );
  const past = registrations.filter((r) => !upcoming.includes(r));

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-6">
        <h1 className="type-display">Your bookings</h1>
        <Link href="/account" className="type-label text-teal no-underline shrink-0">
          Settings
        </Link>
      </div>

      <UpdatesStrip updates={updates} hasHistory={notificationCount > 0} />

      {upcoming.length === 0 && past.length === 0 && waitlistEntries.length === 0 && (
        <EmptyState
          title="No bookings yet"
          body="Book a class through your teacher's page and it appears here."
        />
      )}

      {waitlistEntries.length > 0 && (
        <section className="mb-8">
          <h2 className="type-subtitle mb-1">Waitlist</h2>
          {waitlistEntries.map((entry) => {
            const cls = entry.class;
            // In the final hour before the deadline a freed spot goes to
            // whoever claims it first — show the claim button then.
            const canClaim =
              cls.status === 'open' &&
              cls.calendarEntry.cancelledAt === null &&
              cls._count.registrations < cls.maxStudents &&
              getWaitlistWindow(
                cls.calendarEntry.date,
                cls.calendarEntry.startTime,
                cls.cancelDeadline,
                cls.calendarEntry.teacher.defaultTimezone,
              ) === 'first_come_first_claimed';
            return (
              <div key={entry.id} className="min-h-14 py-2 border-b border-border last:border-b-0">
                <p className="text-base text-ink">{cls.calendarEntry.classType}</p>
                <p className="type-caption">
                  {formatDayHeader(cls.calendarEntry.date)} · {timeToHHmm(cls.calendarEntry.startTime)} · position {entry.position} ·{' '}
                  with {cls.calendarEntry.teacher.firstName} {cls.calendarEntry.teacher.lastName}
                </p>
                <WaitlistEntryActions entryId={entry.id} classId={cls.id} canClaim={canClaim} />
              </div>
            );
          })}
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="mb-8">
          <h2 className="type-subtitle mb-2">Upcoming</h2>
          <div className="flex flex-col gap-3">
            {upcoming.map((reg) => {
              const cls = reg.class;
              const cancelled = cls.calendarEntry.cancelledAt !== null;
              const variant = deriveBadgeVariant(
                cls.status,
                cancelled,
                cls._count.registrations,
                cls.minStudents,
                cls.maxStudents,
              );
              return (
                <div key={reg.id} className="bg-sand-soft border border-border rounded-card p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="type-label text-ink">
                      {formatDayHeader(cls.calendarEntry.date)} · {timeToHHmm(cls.calendarEntry.startTime)}
                    </span>
                    <StatusBadge variant={variant} />
                  </div>
                  <p className="type-subtitle mt-1">{cls.calendarEntry.classType}</p>
                  <p className="type-caption mt-0.5">
                    {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
                    {' · '}with {cls.calendarEntry.teacher.firstName} {cls.calendarEntry.teacher.lastName}
                  </p>
                  {reg.status === 'late_cancel' ? (
                    <p className="type-caption mt-2">
                      Cancelled after the deadline — this class is still charged.
                    </p>
                  ) : (
                    cls.status === 'open' && !cancelled && (
                      <div className="mt-3">
                        <CancelBookingButton
                          registrationId={reg.id}
                          cancelDeadline={cls.cancelDeadline}
                        />
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="type-subtitle mb-1">Past classes</h2>
          {past.map((reg) => {
            const cls = reg.class;
            const payment = reg.payment;
            const isPaid = payment?.status === 'paid';
            return (
              <div key={reg.id} className="min-h-14 py-3 border-b border-border last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-base text-ink">{cls.calendarEntry.classType}</p>
                    <p className="type-caption">
                      {formatDayHeader(cls.calendarEntry.date)} · with {cls.calendarEntry.teacher.firstName} {cls.calendarEntry.teacher.lastName}
                    </p>
                  </div>
                  {payment && (
                    <div className="text-right shrink-0">
                      <p className={`type-number ${isPaid ? '' : 'text-brown'}`}>
                        €{Number(payment.amount).toFixed(2)}
                      </p>
                      {/* Payment state is text, never a badge */}
                      <p className={`type-caption ${paymentStateText(payment.status).className}`}>
                        {paymentStateText(payment.status).label}
                      </p>
                    </div>
                  )}
                </div>
                {payment && !isPaid && (
                  <details className="mt-2">
                    <summary className="type-label text-teal cursor-pointer">
                      How to pay
                    </summary>
                    <div className="mt-2 bg-sand-soft border border-border rounded-field p-4">
                      {cls.calendarEntry.teacher.bankIban ? (
                        <>
                          <p className="type-body">
                            Transfer{' '}
                            <span className="type-number">€{Number(payment.amount).toFixed(2)}</span> to:
                          </p>
                          <p className="type-body text-ink mt-1 tabular-nums">{cls.calendarEntry.teacher.bankIban}</p>
                          <p className="type-caption">
                            {cls.calendarEntry.teacher.bankAccountName ??
                              `${cls.calendarEntry.teacher.firstName} ${cls.calendarEntry.teacher.lastName}`}
                            {' · '}mention &ldquo;{cls.calendarEntry.classType} {formatDayHeader(cls.calendarEntry.date)}&rdquo;
                          </p>
                          <PaymentQr
                            iban={cls.calendarEntry.teacher.bankIban}
                            beneficiary={
                              cls.calendarEntry.teacher.bankAccountName ??
                              `${cls.calendarEntry.teacher.firstName} ${cls.calendarEntry.teacher.lastName}`
                            }
                            amount={Number(payment.amount)}
                            remittance={`${cls.calendarEntry.classType} ${formatDayHeader(cls.calendarEntry.date)}`}
                          />
                        </>
                      ) : (
                        <p className="type-body">
                          Pay your teacher directly — cash or transfer, whatever you
                          two agreed. They&apos;ll mark it as received.
                        </p>
                      )}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
