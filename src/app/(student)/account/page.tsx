import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { Icon } from '@/components/ui/icon';
import { ListRow } from '@/components/ui/list-row';
import { AccountSecurity } from '@/components/account/account-security';
import { SignOutButton } from '@/components/account/sign-out-button';
import { InstallAppRow } from '@/components/account/install-app-row';
import { ReportProblemRow } from '@/components/account/report-problem-row';
import { NameForm } from '@/components/student/name-form';
import { ContactDetailsForm } from '@/components/student/contact-details-form';

export const dynamic = 'force-dynamic';

const SETTINGS_ITEMS = [
  { href: '/account/tier', label: 'Your tier' },
  { href: '/account/notifications', label: 'Notifications' },
  { href: '/account/privacy', label: 'Privacy' },
  { href: '/account/data', label: 'Data & deletion' },
];

// The student settings index: personal details inline, then one row per
// settings area, then — for a dual-hat account — a link to the teacher
// side, then sign-in.
export default async function StudentSettingsPage() {
  const session = await getSession();
  if (!session?.studentId) redirectNonStudent(session);

  const student = await prisma.student.findUnique({
    where: { id: session.studentId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      email: true,
      birthday: true,
      address: true,
    },
  });
  if (!student) redirect('/login');

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-display mb-6">Settings</h1>

      <section className="mb-8">
        <h2 className="type-subtitle mb-4">Personal details</h2>
        <NameForm
          studentId={student.id}
          initialFirstName={student.firstName}
          initialLastName={student.lastName}
        />
        <div className="mt-8">
          <ContactDetailsForm
            studentId={student.id}
            initialPhone={student.phone ?? ''}
            initialBirthday={student.birthday ? student.birthday.toISOString().slice(0, 10) : ''}
            initialAddress={student.address ?? ''}
          />
        </div>
      </section>

      <div>
        {SETTINGS_ITEMS.map((item) => (
          <ListRow key={item.href} href={item.href} className="flex items-center gap-3 no-underline">
            <span className="flex-1 text-base text-ink">{item.label}</span>
            <Icon name="chevron-right" size={20} className="text-brown-light" />
          </ListRow>
        ))}
        <InstallAppRow />
        <ReportProblemRow />
      </div>

      {session.teacherId && (
        <section className="mt-10 pt-6 border-t border-border">
          <ListRow href="/schedule" className="flex items-center gap-3 no-underline">
            <span className="flex-1 text-base text-ink">Your teaching side</span>
            <Icon name="chevron-right" size={20} className="text-brown-light" />
          </ListRow>
        </section>
      )}

      <section className="mt-10 pt-6 border-t border-border">
        <h2 className="type-subtitle mb-3">Sign-in</h2>
        <AccountSecurity email={student.email} redirectPath="/account" />
        <div className="mt-5">
          <SignOutButton accountId={session.accountId} />
        </div>
      </section>
    </div>
  );
}
