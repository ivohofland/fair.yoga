import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatStudentName } from '@/lib/format';
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
      teacher: { select: { defaultTimezone: true, pageSlug: true } },
      teacherRoom: { include: { room: true } },
      registrations: {
        include: {
          student: {
            include: {
              studentPrivacy: {
                where: { teacherId: session.teacherId },
                select: { shareFullName: true },
              },
            },
          },
          payment: true,
        },
        orderBy: { registeredAt: 'asc' },
      },
      _count: { select: { waitlistEntries: true } },
    },
  });

  if (!cls || cls.teacherId !== session.teacherId) {
    redirect('/');
  }

  // Serialize registrations for client components (Prisma Dates/Decimals are not serializable)
  function getStudentDisplayName(student: { firstName: string; lastName: string; claimedAt: Date | null; studentPrivacy: { shareFullName: boolean }[] }): string {
    const shareFullName = !student.claimedAt || (student.studentPrivacy[0]?.shareFullName ?? false);
    return formatStudentName(student.firstName, student.lastName, shareFullName);
  }

  const activeRegistrations = cls.registrations.filter((r) => r.status !== 'cancelled');

  // Seat occupancy excludes late_cancel: those students are still charged
  // (they stay in activeRegistrations for attendance/payments) but their
  // seat is free — the booking page sells it, so the count here must agree.
  const seatCount = cls.registrations.filter((r) =>
    ['registered', 'attended', 'no_show'].includes(r.status),
  ).length;

  const attendanceItems: AttendanceItem[] = activeRegistrations
    .map((r) => ({
      registrationId: r.id,
      studentName: getStudentDisplayName(r.student),
      status: r.status,
    }));

  const paymentItems: PaymentItem[] = cls.registrations
    .filter((r) => r.status !== 'cancelled' && r.payment)
    .map((r) => ({
      paymentId: r.payment!.id,
      studentId: r.studentId,
      studentName: getStudentDisplayName(r.student),
      amount: Number(r.payment!.amount),
      status: r.payment!.status,
    }));

  // Actual tier prices for completed class pricing breakdown
  const tierPrices = activeRegistrations
    .filter((r) => r.price !== null)
    .map((r) => ({ tier: r.tierAtBooking, price: Number(r.price) }));

  // Check-in available: in_progress, or open within 15 min of start
  // (class start resolved in the teacher's timezone)
  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const minutesToStart = (classStart.getTime() - now) / 60_000;
  const showCheckin = cls.status === 'in_progress' || (cls.status === 'open' && minutesToStart <= 15);

  return (
    <>
      <PageHeader
        title={cls.classType}
        backHref="/" backLabel="Schedule"
        action={
          cls.status === 'draft'
            ? <PublishClassButton classId={cls.id} />
            : showCheckin
              ? <CompleteClassButton classId={cls.id} />
              : undefined
        }
      />
      <ClassInfo
        cls={cls}
        registrationCount={seatCount}
        waitlistCount={cls._count.waitlistEntries}
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
      {cls.status === 'open' && !showCheckin && activeRegistrations.length > 0 && (
        <div className="py-6">
          <h2 className="type-subtitle mb-1">Registered students</h2>
          <div>
            {activeRegistrations.map((r) => (
              <Link
                key={r.id}
                href={`/students/${r.studentId}`}
                className="flex items-center min-h-14 py-2 border-b border-border last:border-b-0 no-underline"
              >
                <span className="text-base text-ink">{getStudentDisplayName(r.student)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Draft: pricing preview */}
      {cls.status === 'draft' && (
        <PricingPreview cls={cls} />
      )}

      {/* Open (not check-in): pricing preview */}
      {cls.status === 'open' && !showCheckin && (
        <PricingPreview cls={cls} />
      )}

      {/* Completed: Show pricing breakdown + payment checklist */}
      {cls.status === 'completed' && (
        <>
          <PricingBreakdown cls={cls} tierPrices={tierPrices} />
          <PaymentChecklist items={paymentItems} />
        </>
      )}

      {/* Cancelled */}
      {cls.status === 'cancelled' && (
        <div className="py-8 text-center type-body">
          This class was cancelled.
        </div>
      )}

      {/* Actions: share while bookable, announce while it has students, cancel while upcoming */}
      {cls.status !== 'cancelled' && (
        <div className="mt-8 pt-6 border-t border-border flex flex-col items-start gap-5">
          {cls.status === 'open' && <ShareBookingLink pageSlug={cls.teacher.pageSlug} />}
          {activeRegistrations.length > 0 && (
            <SendAnnouncement classId={cls.id} recipientHint="everyone in this class" />
          )}
          {(cls.status === 'draft' || cls.status === 'open') && (
            <CancelClassButton classId={cls.id} registrationCount={activeRegistrations.length} />
          )}
        </div>
      )}
    </>
  );
}
