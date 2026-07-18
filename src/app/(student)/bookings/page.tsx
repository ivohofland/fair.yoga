import Link from 'next/link';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import { StatusBadge, deriveBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { CancelBookingButton } from '@/components/student/cancel-booking-button';
import { WaitlistEntryActions } from '@/components/student/waitlist-entry-actions';
import { PaymentQr } from '@/components/student/payment-qr';
import { formatRoomLocation } from '@/lib/format';
import { getWaitlistWindow } from '@/services/waitlist';

export const dynamic = 'force-dynamic';

function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// The student's home: upcoming bookings, waitlist spots, past classes with
// what to pay and where. No engagement tricks — a quiet ledger.
export default async function StudentBookingsPage() {
  const session = await getSession();
  if (!session || session.userType !== 'student') redirect('/login');

  const [registrations, waitlistEntries] = await Promise.all([
    prisma.registration.findMany({
      where: { studentId: session.userId, status: { not: 'cancelled' } },
      orderBy: { class: { date: 'desc' } },
      include: {
        class: {
          include: {
            teacher: {
              select: { firstName: true, lastName: true, pageSlug: true, bankIban: true, bankAccountName: true },
            },
            teacherRoom: { include: { room: true } },
            _count: { select: { registrations: true } },
          },
        },
        payment: true,
      },
    }),
    prisma.waitlistEntry.findMany({
      where: { studentId: session.userId, status: 'waiting' },
      include: {
        class: {
          include: {
            teacher: {
              select: { firstName: true, lastName: true, pageSlug: true, defaultTimezone: true },
            },
            _count: {
              select: {
                registrations: {
                  where: { status: { in: ['registered', 'attended', 'no_show'] } },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const now = new Date();
  const upcoming = registrations.filter(
    (r) => r.class.status === 'open' || r.class.status === 'in_progress' || new Date(r.class.date) >= now,
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
              cls._count.registrations < cls.maxStudents &&
              getWaitlistWindow(
                cls.date,
                cls.startTime,
                cls.cancelDeadline,
                cls.teacher.defaultTimezone,
              ) === 'first_come_first_claimed';
            return (
              <div key={entry.id} className="min-h-14 py-2 border-b border-border last:border-b-0">
                <p className="text-base text-ink">{cls.classType}</p>
                <p className="type-caption">
                  {formatDayHeader(cls.date)} · {cls.startTime} · position {entry.position} ·{' '}
                  with {cls.teacher.firstName} {cls.teacher.lastName}
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
              const variant = deriveBadgeVariant(
                cls.status,
                cls._count.registrations,
                cls.minStudents,
                cls.maxStudents,
              );
              return (
                <div key={reg.id} className="bg-sand-soft border border-border rounded-card p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="type-label text-ink">
                      {formatDayHeader(cls.date)} · {cls.startTime}
                    </span>
                    <StatusBadge variant={variant} />
                  </div>
                  <p className="type-subtitle mt-1">{cls.classType}</p>
                  <p className="type-caption mt-0.5">
                    {formatRoomLocation(cls.teacherRoom.room.roomName, cls.teacherRoom.room.venueName)}
                    {' · '}with {cls.teacher.firstName} {cls.teacher.lastName}
                  </p>
                  {reg.status === 'late_cancel' ? (
                    <p className="type-caption mt-2">
                      Cancelled after the deadline — this class is still charged.
                    </p>
                  ) : (
                    cls.status === 'open' && (
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
                    <p className="text-base text-ink">{cls.classType}</p>
                    <p className="type-caption">
                      {formatDayHeader(cls.date)} · with {cls.teacher.firstName} {cls.teacher.lastName}
                    </p>
                  </div>
                  {payment && (
                    <div className="text-right shrink-0">
                      <p className={`type-number ${isPaid ? '' : 'text-brown'}`}>
                        €{Number(payment.amount).toFixed(2)}
                      </p>
                      {/* Payment state is text, never a badge */}
                      <p className={`type-caption ${isPaid ? 'text-teal' : ''}`}>
                        {isPaid ? '✓ Paid' : '○ Unpaid'}
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
                      {cls.teacher.bankIban ? (
                        <>
                          <p className="type-body">
                            Transfer{' '}
                            <span className="type-number">€{Number(payment.amount).toFixed(2)}</span> to:
                          </p>
                          <p className="type-body text-ink mt-1 tabular-nums">{cls.teacher.bankIban}</p>
                          <p className="type-caption">
                            {cls.teacher.bankAccountName ??
                              `${cls.teacher.firstName} ${cls.teacher.lastName}`}
                            {' · '}mention &ldquo;{cls.classType} {formatDayHeader(cls.date)}&rdquo;
                          </p>
                          <PaymentQr
                            iban={cls.teacher.bankIban}
                            beneficiary={
                              cls.teacher.bankAccountName ??
                              `${cls.teacher.firstName} ${cls.teacher.lastName}`
                            }
                            amount={Number(payment.amount)}
                            remittance={`${cls.classType} ${formatDayHeader(cls.date)}`}
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
