import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { StudentDirectory } from '@/components/students/student-directory';
import { SendAnnouncement } from '@/components/class/send-announcement';

export default function StudentsPage() {
  return (
    <>
      <PageHeader
        title="Students"
        backHref={null}
        variant="display"
        action={<Link href="/students/new" className="type-label text-teal no-underline">+ Add student</Link>}
      />
      <div className="mb-5">
        <SendAnnouncement recipientHint="all your students" />
      </div>
      <StudentDirectory />
      <div className="mt-6">
        <Link href="/students/archived" className="text-brown text-sm opacity-60">
          View archived students
        </Link>
      </div>
    </>
  );
}
