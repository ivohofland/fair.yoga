import { PageHeader } from '@/components/layout/page-header';
import { CreateStudentForm } from '@/components/students/create-student-form';

export default function NewStudentPage() {
  return (
    <>
      {/* "Contact", matching the link that reaches this page and the
          section the new row appears in — this creates an Invitation, not a
          student (#166). */}
      <PageHeader title="New contact" backHref="/students" backLabel="Students" />
      <CreateStudentForm />
    </>
  );
}
