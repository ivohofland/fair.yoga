import { PageHeader } from '@/components/layout/page-header';
import { CreateStudentForm } from '@/components/students/create-student-form';

export default function NewStudentPage() {
  return (
    <>
      <PageHeader title="New student" backHref="/students" backLabel="All students" />
      <CreateStudentForm />
    </>
  );
}
