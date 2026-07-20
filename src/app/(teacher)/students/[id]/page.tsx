import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatStudentName } from '@/lib/format';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { EditStudentForm } from '@/components/students/edit-student-form';
import { RemoveStudentButton } from '@/components/students/remove-student-button';
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
          This student hasn&apos;t created an account yet. You can edit their details.
        </p>
      )}

      {/* Unlinked: editable form + remove */}
      {isUnlinked ? (
        <section className="mb-8">
          <EditStudentForm
            studentId={student.id}
            initialFirstName={student.firstName}
            initialLastName={student.lastName}
            initialEmail={student.email}
          />
          <div className="mt-6 pt-6 border-t border-border">
            <RemoveStudentButton studentId={student.id} studentName={displayName} />
          </div>
        </section>
      ) : (
        /* Claimed: read-only contact info (privacy-filtered) */
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
                <p className="text-base text-ink">{new Date(student.birthday).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</p>
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
      )}

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
                      {new Date(reg.class.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
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
                classDate: new Date(reg.class.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
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
