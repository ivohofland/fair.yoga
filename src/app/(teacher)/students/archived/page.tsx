import { PageHeader } from '@/components/layout/page-header';
import { StudentDirectory } from '@/components/students/student-directory';

export default function ArchivedStudentsPage() {
  return (
    <>
      <PageHeader title="Archived students" backHref="/students" backLabel="All students" />
      <StudentDirectory archived />
    </>
  );
}
