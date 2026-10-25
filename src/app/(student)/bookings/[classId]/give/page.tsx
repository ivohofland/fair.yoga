import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { Icon } from '@/components/ui/icon';
import { MethodChooser } from '@/components/student/method-chooser';
import { canSeeGivePage } from '@/lib/donation-prompt';
import { formatDayHeader } from '@/lib/format';
import {
  PAYMENTS_PAUSED_COPY,
  paymentMethodsForTeacher,
  paymentReference,
  teacherPaymentSelect,
} from '@/lib/payment-methods';

export const dynamic = 'force-dynamic';

// How to give for one donation class the signed-in student came to. It names
// no amount, and reads the teacher's methods live, so a payout pause shows.
export default async function GivePage({ params }: { params: Promise<{ classId: string }> }) {
  const session = await getSession();
  if (!session?.studentId) redirectNonStudent(session);
  const { classId } = await params;

  // Keyed by the session's own student: another student's class finds no row,
  // and answers exactly as a class that does not exist.
  const registration = await prisma.registration.findUnique({
    where: { classId_studentId: { classId, studentId: session.studentId } },
    include: {
      class: {
        include: {
          calendarEntry: {
            include: {
              teacher: { select: { firstName: true, lastName: true, ...teacherPaymentSelect } },
            },
          },
        },
      },
    },
  });
  if (!registration) notFound();
  const cls = registration.class;
  const entry = cls.calendarEntry;
  const teacher = entry.teacher;
  if (
    !canSeeGivePage({
      classStatus: cls.status,
      classCancelledAt: entry.cancelledAt,
      pricingMode: cls.pricingMode,
      registrationStatus: registration.status,
      donationInvitedAt: registration.donationInvitedAt,
    })
  ) {
    notFound();
  }

  const answer = paymentMethodsForTeacher(teacher, cls.currency);
  // `paymentMethodsForTeacher` never returns a processor method; the filter states it for the type.
  const methods = answer.kind === 'methods' ? answer.methods.filter((m) => m.kind !== 'processor') : [];

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-title">Thank you for coming.</h1>
      <p className="type-caption mb-4">
        {`${entry.classType} · ${formatDayHeader(entry.date)} · with ${teacher.firstName} ${teacher.lastName}`}
      </p>
      {answer.kind === 'paused' ? (
        <p className="type-body mb-6">{PAYMENTS_PAUSED_COPY}</p>
      ) : methods.length === 0 ? (
        <p className="type-body mb-6">Give your teacher directly, however suits you.</p>
      ) : (
        <section className="mb-6">
          <MethodChooser
            name="give-method"
            methods={methods}
            amount={{ kind: 'open' }}
            currency={cls.currency}
            reference={paymentReference(entry)}
          />
        </section>
      )}
    </div>
  );
}
