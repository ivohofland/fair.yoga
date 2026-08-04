import { PageHeader } from '@/components/layout/page-header';
import { ContactList } from '@/components/students/contact-list';

export default function ArchivedContactsPage() {
  return (
    <>
      <PageHeader title="Archived contacts" backHref="/students" backLabel="Students" />
      <ContactList archived />
    </>
  );
}
