import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { formatStudentName } from '@/lib/format';
import { redirect } from 'next/navigation';
import { PageHeader } from '@/components/layout/page-header';
import { EditStudentForm } from '@/components/students/edit-student-form';
import { RemoveStudentButton } from '@/components/students/remove-student-button';
import { ArchiveStudentButton } from '@/components/students/archive-student-button';

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
        where: { teacherId: session.userId },
        select: { id: true, isArchived: true },
      },
      studentPrivacy: {
        where: { teacherId: session.userId },
      },
      registrations: {
        where: { class: { teacherId: session.userId } },
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
      <PageHeader title={displayName} backHref={isArchived ? '/students/archived' : '/students'} />

      {isUnlinked && (
        <p className="text-xs text-brown opacity-60 mb-6">
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
          <h2 className="font-heading text-lg font-bold text-teal mb-3">Contact</h2>
          <div className="flex flex-col gap-2">
            {showEmail && student.email && (
              <div>
                <span className="text-sm text-brown">Email</span>
                <p className="text-dark">{student.email}</p>
              </div>
            )}
            {showPhone && student.phone && (
              <div>
                <span className="text-sm text-brown">Phone</span>
                <p className="text-dark">{student.phone}</p>
              </div>
            )}
            {showBirthday && student.birthday && (
              <div>
                <span className="text-sm text-brown">Birthday</span>
                <p className="text-dark">{new Date(student.birthday).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</p>
              </div>
            )}
            {showAddress && student.address && (
              <div>
                <span className="text-sm text-brown">Address</span>
                <p className="text-dark">{student.address}</p>
              </div>
            )}
            {!showEmail && !showPhone && !showBirthday && !showAddress && (
              <p className="text-sm text-brown">No contact information shared by this student.</p>
            )}
          </div>
        </section>
      )}

      {/* Attendance history */}
      <section className="mb-8">
        <h2 className="font-heading text-lg font-bold text-teal mb-3">Attendance</h2>
        {student.registrations.length === 0 ? (
          <p className="text-sm text-brown">No class history.</p>
        ) : (
          <div className="flex flex-col">
            {student.registrations.map((reg) => (
              <div key={reg.id} className="flex justify-between items-center py-3 border-b border-border">
                <div>
                  <p className="text-dark">{reg.class.classType}</p>
                  <p className="text-sm text-brown">
                    {new Date(reg.class.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    {' · '}{reg.class.startTime}
                  </p>
                </div>
                <span className={`text-sm ${reg.status === 'attended' ? 'text-teal' : reg.status === 'cancelled' ? 'text-error' : 'text-brown'}`}>
                  {reg.status.replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Payment history */}
      <section className="mb-8">
        <h2 className="font-heading text-lg font-bold text-teal mb-3">Payments</h2>
        {student.registrations.filter(r => r.payment).length === 0 ? (
          <p className="text-sm text-brown">No payment history.</p>
        ) : (
          <div className="flex flex-col">
            {student.registrations
              .filter(r => r.payment)
              .map((reg) => (
                <div key={reg.id} className="flex justify-between items-center py-3 border-b border-border">
                  <div>
                    <p className="text-dark">{reg.class.classType}</p>
                    <p className="text-sm text-brown">
                      {new Date(reg.class.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-teal">&euro;{Number(reg.payment!.amount).toFixed(2)}</p>
                    <p className={`text-sm ${reg.payment!.status === 'paid' ? 'text-teal' : 'text-brown'}`}>
                      {reg.payment!.status}
                    </p>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

      {/* Archive (claimed students) */}
      {!isUnlinked && (
        <section className="pt-6 border-t border-border">
          <ArchiveStudentButton studentId={student.id} isArchived={isArchived} />
        </section>
      )}
    </>
  );
}
