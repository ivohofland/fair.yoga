import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { StudentDirectory } from '@/components/students/student-directory';

export default function StudentsPage() {
  return (
    <>
      <PageHeader title="Students" />
      <div className="mb-4">
        <Link href="/students/new" className="text-teal text-sm font-medium">
          + Add student
        </Link>
      </div>
      <StudentDirectory />
    </>
  );
}
