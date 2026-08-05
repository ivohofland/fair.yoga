import Link from 'next/link';
import { PageHeader } from '@/components/layout/page-header';
import { StudentDirectory } from '@/components/students/student-directory';
import { ContactList } from '@/components/students/contact-list';
import { SendAnnouncement } from '@/components/class/send-announcement';

export default function StudentsPage() {
  return (
    <>
      <PageHeader
        title="Students"
        backHref={null}
        variant="display"
        // "Contact", not "student": since #166 this creates an Invitation,
        // and the person lands in the Contacts section below rather than in
        // the directory above. Labelled "student", a teacher who used it
        // then scanned the student list would conclude it had failed.
        action={<Link href="/students/new" className="type-label text-teal no-underline">+ Add contact</Link>}
      />
      <div className="mb-5">
        <SendAnnouncement recipientHint="your booked students" />
      </div>
      <StudentDirectory />
      <div className="mt-6">
        <Link href="/students/archived" className="text-brown text-sm opacity-60">
          View archived students
        </Link>
      </div>

      <section className="mt-10">
        <h2 className="type-subtitle mb-1">Contacts</h2>
        <p className="type-caption mb-4">
          Contacts you&apos;ve invited. They join your students once they accept, or book one of
          your classes.
        </p>
        <ContactList />
        <div className="mt-6">
          <Link href="/students/contacts/archived" className="text-brown text-sm opacity-60">
            View archived contacts
          </Link>
        </div>
      </section>
    </>
  );
}
