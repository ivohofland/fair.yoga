import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatStudentName, formatDateWithYear, formatDateShort } from '@/lib/format';
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
    include: {
      teacherStudents: {
        where: { teacherId: session.teacherId },
        select: { id: true, isArchived: true },
      },
      studentPrivacy: {
        where: { teacherId: session.teacherId },
      },
      registrations: {
        where: { class: { teacherId: session.teacherId } },
        include: {
          class: { select: { classType: true, date: true, startTime: true } },
          payment: true,
        },
        orderBy: { registeredAt: 'desc' },
      },
    },
  });

  if (!student || student.teacherStudents.length === 0) redirect('/students');

  // #166: unreachable for rows created after acceptance-gated linking —
  // nothing creates an unclaimed Student any more. Kept because removing
  // it means removing the claim path (lib/auth/account.ts:34-50), the
  // Student_claim_link_check constraint and Student.claimedAt together.
  // Filed as a leaf. Do NOT treat this branch as a live privacy rule.
  const isUnlinked = !student.claimedAt;
  const isArchived = student.teacherStudents[0]?.isArchived ?? false;
  // For claimed students, respect privacy settings
  const privacy = student.studentPrivacy[0];
  const shareFullName = isUnlinked || (privacy?.shareFullName ?? false);
  const displayName = formatStudentName(student.firstName, student.lastName, shareFullName);
  const showEmail = isUnlinked || (privacy?.shareEmail ?? false);
  const showPhone = isUnlinked || (privacy?.sharePhone ?? false);
  const showBirthday = isUnlinked || (privacy?.shareBirthday ?? false);
  const showAddress = isUnlinked || (privacy?.shareAddress ?? false);

  return (
    <>
      <PageHeader title={displayName} backHref={isArchived ? '/students/archived' : '/students'} backLabel={isArchived ? 'Archived students' : 'All students'} />

      {isUnlinked && (
        <p className="type-caption mb-6">
          This student hasn&apos;t created an account yet.
        </p>
      )}

      {/*
        Task 10 (#166) removed the editable-form branch that used to sit
        here for unlinked students: `EditStudentForm` had no route to submit
        to once the teacher branch of `PUT /api/students/[id]` was deleted,
        and `RemoveStudentButton` already points at `DELETE
        /api/invitations/[id]`, which has no row for a `Student.id` — Task
        9's repoint is what would have made this call site 404 on every
        legacy unclaimed row still in a live database. `isUnlinked` itself
        stays (see its declaration above); this section now always renders
        the read-only, privacy-filtered view.
      */}
      <section className="mb-8">
        <h2 className="type-subtitle mb-3">Contact</h2>
        <div className="flex flex-col gap-2">
          {showEmail && student.email && (
            <div>
              <span className="type-label">Email</span>
              <p className="text-base text-ink">{student.email}</p>
            </div>
          )}
          {showPhone && student.phone && (
            <div>
              <span className="type-label">Phone</span>
              <p className="text-base text-ink">{student.phone}</p>
            </div>
          )}
          {showBirthday && student.birthday && (
            <div>
              <span className="type-label">Birthday</span>
              {/*
                `formatDateShort`, not `formatDateWithYear`: this field omits
                the year on purpose (a birth *year* is a different disclosure
                than a birth *date* on a privacy-first page), and
                `formatDateWithYear` always appends one. `formatDateShort`
                reads with UTC accessors, which avoids the same
                host-local-shifts-the-day bug as the two class dates below.
              */}
              <p className="text-base text-ink">{formatDateShort(student.birthday)}</p>
            </div>
          )}
          {showAddress && student.address && (
            <div>
              <span className="type-label">Address</span>
              <p className="text-base text-ink">{student.address}</p>
            </div>
          )}
          {!showEmail && !showPhone && !showBirthday && !showAddress && (
            <EmptyState title="No contact information shared by this student." />
          )}
        </div>
      </section>

      {/* Attendance history (claimed students only) */}
      {!isUnlinked && (
        <section className="mb-8">
          <h2 className="type-subtitle mb-3">Attendance</h2>
          {student.registrations.length === 0 ? (
            <EmptyState title="No class history." />
          ) : (
            <div className="flex flex-col">
              {student.registrations.map((reg) => (
                <div key={reg.id} className="flex justify-between items-center py-3 border-b border-border last:border-b-0">
                  <div>
                    <p className="text-base text-ink">{reg.class.classType}</p>
                    <p className="type-caption">
                      {formatDateWithYear(reg.class.date)}
                      {' · '}{reg.class.startTime}
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
      )}

      {/* Payment history (claimed students only) */}
      {!isUnlinked && (
        <section className="mb-8">
          <h2 className="type-subtitle mb-3">Payments</h2>
          <StudentPaymentList
            items={student.registrations
              .filter((r) => r.payment)
              .map((reg) => ({
                paymentId: reg.payment!.id,
                classType: reg.class.classType,
                classDate: formatDateWithYear(reg.class.date),
                amount: Number(reg.payment!.amount),
                status: reg.payment!.status,
              }))}
          />
        </section>
      )}

      {/* Archive (claimed students) */}
      {!isUnlinked && (
        <section className="pt-6 border-t border-border">
          <ArchiveStudentButton studentId={student.id} isArchived={isArchived} />
        </section>
      )}
    </>
  );
}
