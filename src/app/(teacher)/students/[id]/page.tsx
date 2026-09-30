import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatDateWithYear, formatDayMonth } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';
import { isOutstanding } from '@/lib/payment-status';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { ArchiveStudentButton } from '@/components/students/archive-student-button';
import { StudentPaymentList } from '@/components/students/student-payment-list';

export default async function StudentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireTeacherSession();
  const { id } = await params;

  const student = await prisma.student.findUnique({
    where: { id },
    select: {
      ...studentVisibilitySelect(session.teacherId),
      teacherStudents: {
        where: { teacherId: session.teacherId },
        select: { id: true, isArchived: true },
      },
      registrations: {
        where: { class: { calendarEntry: { teacherId: session.teacherId } } },
        include: {
          class: {
            select: {
              calendarEntry: { select: { classType: true, date: true, startTime: true } },
            },
          },
          payment: true,
        },
        orderBy: { registeredAt: 'desc' },
      },
    },
  });

  if (!student || student.teacherStudents.length === 0) redirect('/students');

  const isArchived = student.teacherStudents[0]?.isArchived ?? false;
  const visible = projectStudentForTeacher(student, session.teacherId);
  const isUnclaimed = !visible.claimedAt;
  const displayName = visible.displayName;

  const paymentRegistrations = student.registrations.filter((r) => r.payment);
  const outstandingRegistrations = paymentRegistrations.filter((reg) => isOutstanding(reg.payment!.status));
  const outstanding = {
    ids: outstandingRegistrations.map((reg) => reg.payment!.id),
    // Summed as Prisma.Decimal so no cent is lost to float addition;
    // converted to a number once, at the end, for the prop's type.
    total: outstandingRegistrations
      .reduce((sum, reg) => sum.plus(reg.payment!.amount), new Prisma.Decimal(0))
      .toNumber(),
  };

  return (
    <>
      <PageHeader title={displayName} backHref={isArchived ? '/students/archived' : '/students'} backLabel={isArchived ? 'Archived students' : 'All students'} />

      {isUnclaimed && (
        <p className="type-caption mb-6">
          This student hasn&apos;t created an account yet.
        </p>
      )}

      <section className="mb-8">
        <h2 className="type-subtitle mb-3">Contact</h2>
        <div className="flex flex-col gap-2">
          {visible.email && (
            <div>
              <span className="type-label">Email</span>
              <p className="text-base text-ink">{visible.email}</p>
            </div>
          )}
          {visible.phone && (
            <div>
              <span className="type-label">Phone</span>
              <p className="text-base text-ink">{visible.phone}</p>
            </div>
          )}
          {visible.birthday && (
            <div>
              <span className="type-label">Birthday</span>
              {/* The year is absent from `TeacherVisibleStudent` itself (`src/lib/student-visibility.ts`), so nothing read from `visible` can show it; render from `visible`, never the raw row. */}
              <p className="text-base text-ink">{formatDayMonth(visible.birthday)}</p>
            </div>
          )}
          {visible.age !== null && (
            <div>
              <span className="type-label">Age</span>
              <p className="text-base text-ink">{visible.age}</p>
            </div>
          )}
          {visible.address && (
            <div>
              <span className="type-label">Address</span>
              <p className="text-base text-ink whitespace-pre-line">{visible.address}</p>
            </div>
          )}
          {/*
            "to show", not "shared by this student": this renders both when
            the student withheld everything and when they shared a field they
            have never filled in (`sharePhone` over a null `phone`). The old
            copy blamed the student's choice for what can be an empty column.
            `email` is non-null on `Student`, so `shareEmail: true` always
            renders a row and can never reach this branch.
          */}
          {!visible.email && !visible.phone && !visible.birthday && visible.age === null && !visible.address && (
            <EmptyState title="No contact information to show." />
          )}
        </div>
      </section>

      <section className="mb-8">
        <h2 className="type-subtitle mb-3">Attendance</h2>
        {student.registrations.length === 0 ? (
          <EmptyState title="No class history." />
        ) : (
          <div className="flex flex-col">
            {student.registrations.map((reg) => (
              <div key={reg.id} className="flex justify-between items-center py-3 border-b border-border last:border-b-0">
                <div>
                  <p className="text-base text-ink">{reg.class.calendarEntry.classType}</p>
                  <p className="type-caption">
                    {formatDateWithYear(reg.class.calendarEntry.date)}
                    {' · '}{timeToHHmm(reg.class.calendarEntry.startTime)}
                  </p>
                </div>
                <span className={`text-sm ${reg.status === 'attended' ? 'text-teal' : reg.status === 'cancelled' ? 'text-danger' : 'text-brown'}`}>
                  {reg.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="type-subtitle mb-3">Payments</h2>
        <StudentPaymentList
          items={paymentRegistrations.map((reg) => ({
            paymentId: reg.payment!.id,
            classType: reg.class.calendarEntry.classType,
            classDate: formatDateWithYear(reg.class.calendarEntry.date),
            amount: Number(reg.payment!.amount),
            status: reg.payment!.status,
          }))}
        />
      </section>

      <section className="pt-6 border-t border-border">
        <ArchiveStudentButton
          studentId={student.id}
          studentName={displayName}
          isArchived={isArchived}
          outstanding={outstanding}
        />
      </section>
    </>
  );
}
