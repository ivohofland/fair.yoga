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
import type { AttendanceItem } from '@/components/class/attendance-list';
import type { PaymentItem } from '@/components/class/payment-checklist';

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      teacherRoom: { include: { room: true } },
      registrations: {
        include: {
          student: {
            include: {
              studentPrivacy: {
                where: { teacherId: session.userId },
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

  if (!cls || cls.teacherId !== session.userId) {
    redirect('/');
  }

  // Serialize registrations for client components (Prisma Dates/Decimals are not serializable)
  function getStudentDisplayName(student: { firstName: string; lastName: string; claimedAt: Date | null; studentPrivacy: { shareFullName: boolean }[] }): string {
    const shareFullName = !student.claimedAt || (student.studentPrivacy[0]?.shareFullName ?? false);
    return formatStudentName(student.firstName, student.lastName, shareFullName);
  }

  const attendanceItems: AttendanceItem[] = cls.registrations
    .filter((r) => r.status !== 'cancelled')
    .map((r) => ({
      registrationId: r.id,
      studentName: getStudentDisplayName(r.student),
      status: r.status,
    }));

  const paymentItems: PaymentItem[] = cls.registrations
    .filter((r) => r.status !== 'cancelled' && r.payment)
    .map((r) => ({
      paymentId: r.payment!.id,
      studentName: getStudentDisplayName(r.student),
      amount: Number(r.payment!.amount),
      status: r.payment!.status,
    }));

  // Augment registrations with display names for PricingBreakdown
  const registrationsWithNames = cls.registrations.map((r) => ({
    ...r,
    displayName: getStudentDisplayName(r.student),
  }));
  const clsWithNames = { ...cls, registrations: registrationsWithNames };

  return (
    <>
      <PageHeader title={cls.classType} backHref="/schedule" />
      <ClassInfo
        cls={cls}
        registrationCount={cls.registrations.filter((r) => r.status !== 'cancelled').length}
        waitlistCount={cls._count.waitlistEntries}
      />

      {/* Draft / Open / Full: Show pricing preview */}
      {(cls.status === 'draft' || cls.status === 'open') && (
        <PricingPreview cls={cls} />
      )}

      {/* In Progress: Show attendance checklist + pricing estimate */}
      {cls.status === 'in_progress' && (
        <>
          <AttendanceList items={attendanceItems} />
          <PricingPreview cls={cls} />
        </>
      )}

      {/* Completed: Show pricing breakdown + payment checklist */}
      {cls.status === 'completed' && (
        <>
          <PricingBreakdown cls={clsWithNames} />
          <PaymentChecklist items={paymentItems} />
        </>
      )}

      {/* Cancelled */}
      {cls.status === 'cancelled' && (
        <div className="py-8 text-center text-brown">
          This class was cancelled.
        </div>
      )}
    </>
  );
}
